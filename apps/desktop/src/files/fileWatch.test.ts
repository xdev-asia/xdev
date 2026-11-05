import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type FileText, type FsEvent } from "@/api";
import { DELETE_SETTLE_MS, RELOAD_DEBOUNCE_MS, reconcile, resetWatchState } from "./fileWatch";
import { FileTabs } from "./fileTabs";
import { reloadWithUndo } from "./fileIO";
import { getToasts } from "@/workspace/toastStore";
import { fakeTimers, tick } from "./testClock";

const W = "/wt/a";
const t = (k: string) => k;
const ev = (kind: FsEvent["kind"], rel: string, dir: boolean | null = false): FsEvent => ({ kind, rel, dir });
const text = (body: string, hash: string): FileText => ({ rel: "x", text: body, kind: "text", size: body.length, hash, eol: "lf" });
function setup(disk: Record<string, FileText | null>) {
  const api = createMockApi({});
  const read = vi.spyOn(api, "fileRead").mockImplementation(async (_w, rel) => {
    const f = disk[rel];
    if (!f) throw { code: "not_found" };
    return f;
  });
  const store = new FileTabs();
  const clock = fakeTimers();
  const io = { api, store, t };
  const open = (rel: string, body = "one", hash = "h1") => {
    store.open(W, rel);
    store.loaded(W, rel, text(body, hash));
  };
  const feed = (...events: FsEvent[]) => reconcile(io, W, events, clock.timers);
  return { api, store, clock, read, open, feed, io };
}

beforeEach(() => {
  resetWatchState();
});

it("reloads a clean file after the debounce, silently", async () => {
  const { store, clock, read, open, feed } = setup({ "a.ts": text("two", "h2") });
  open("a.ts");
  feed(ev("update", "a.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS - 1);
  expect(read).not.toHaveBeenCalled();
  await clock.advance(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.get(W, "a.ts")).toMatchObject({ text: "two", saved: "two", hash: "h2", external: null });
  expect(getToasts()).toHaveLength(0);
});

it("a create for an open file re-checks it like an update (macOS reports writes as creates)", async () => {
  const { store, clock, read, open, feed } = setup({ "a.ts": text("two", "h2"), "b.ts": text("disk", "h3") });
  open("a.ts");
  open("b.ts");
  store.edit(W, "b.ts", "mine");
  feed(ev("create", "a.ts"), ev("create", "b.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.get(W, "a.ts")).toMatchObject({ text: "two", hash: "h2", external: null });
  expect(store.get(W, "b.ts")).toMatchObject({ text: "mine", external: "changed" });
});

it("a burst of updates reads once", async () => {
  const { clock, read, open, feed } = setup({ "a.ts": text("two", "h2") });
  open("a.ts");
  feed(ev("update", "a.ts"));
  await clock.advance(30);
  feed(ev("update", "a.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS + 1);
  expect(read).toHaveBeenCalledTimes(1);
});

it("does nothing when the hash on disk is the one loaded (our own write, or a touch)", async () => {
  const { store, clock, open, feed } = setup({ "a.ts": text("one", "h1") });
  open("a.ts");
  const before = store.get(W, "a.ts");
  feed(ev("update", "a.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(store.get(W, "a.ts")).toBe(before);
});

it("marks a file with edits as changed and keeps the edits", async () => {
  const { store, clock, open, feed } = setup({ "a.ts": text("disk", "h2") });
  open("a.ts");
  store.edit(W, "a.ts", "mine");
  feed(ev("update", "a.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(store.get(W, "a.ts")).toMatchObject({ text: "mine", saved: "one", hash: "h1", external: "changed" });
});

it("ignores files that are not open and events for folders", async () => {
  const { clock, read, open, feed } = setup({ "a.ts": text("two", "h2") });
  open("a.ts");
  feed(ev("update", "other.ts"), ev("create", "src", true));
  await clock.advance(1000);
  expect(read).not.toHaveBeenCalled();
});

it("a delete marks the file deleted after the settle time", async () => {
  const { store, clock, open, feed } = setup({});
  open("a.ts");
  feed(ev("delete", "a.ts", null));
  await clock.advance(DELETE_SETTLE_MS - 1);
  expect(store.get(W, "a.ts")!.external).toBeNull();
  await clock.advance(1);
  expect(store.get(W, "a.ts")!.external).toBe("deleted");
});

it("a delete of a folder marks the open files under it", async () => {
  const { store, clock, open, feed } = setup({});
  open("lib/a.ts");
  open("lib/deep/b.ts");
  open("keep.ts");
  feed(ev("delete", "lib", null));
  await clock.advance(DELETE_SETTLE_MS);
  expect(store.get(W, "lib/a.ts")!.external).toBe("deleted");
  expect(store.get(W, "lib/deep/b.ts")!.external).toBe("deleted");
  expect(store.get(W, "keep.ts")!.external).toBeNull();
});

it("a tab closed during the settle time is not marked", async () => {
  const { store, clock, open, feed } = setup({});
  open("a.ts");
  feed(ev("delete", "a.ts", null));
  store.close(W, "a.ts");
  await clock.advance(DELETE_SETTLE_MS);
  expect(store.get(W, "a.ts")).toBeNull();
});

it("a delete with a create of the same name elsewhere is renamed, at once", async () => {
  const { store, open, feed } = setup({});
  open("src/a.ts");
  feed(ev("delete", "src/a.ts", null), ev("create", "lib/a.ts"));
  expect(store.get(W, "src/a.ts")!.external).toBe("renamed");
});

it("a create at the deleted path before the settle time cancels the mark and reads the file", async () => {
  const { store, clock, open, feed } = setup({ "a.ts": text("again", "h2") });
  open("a.ts");
  feed(ev("delete", "a.ts", null));
  await clock.advance(100);
  feed(ev("create", "a.ts"));
  await clock.advance(DELETE_SETTLE_MS);
  expect(store.get(W, "a.ts")).toMatchObject({ external: null, text: "again" });
});

it("a create after the mark cleared it, keeping edits that differ as changed", async () => {
  const { store, clock, open, feed } = setup({ "a.ts": text("back", "h2") });
  open("a.ts");
  store.edit(W, "a.ts", "mine");
  feed(ev("delete", "a.ts", null));
  await clock.advance(DELETE_SETTLE_MS);
  expect(store.get(W, "a.ts")!.external).toBe("deleted");
  feed(ev("create", "a.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(store.get(W, "a.ts")).toMatchObject({ external: "changed", text: "mine" });
});

it("an overflow reads every open file again", async () => {
  const { store, clock, read, open, feed } = setup({ "a.ts": text("a2", "h2"), "b.ts": text("b2", "h3") });
  open("a.ts");
  open("b.ts");
  store.edit(W, "b.ts", "mine");
  feed(ev("overflow", "", null));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.get(W, "a.ts")).toMatchObject({ text: "a2", external: null });
  expect(store.get(W, "b.ts")).toMatchObject({ text: "mine", external: "changed" });
});

it("an overflow marks an open file that vanished as deleted", async () => {
  const { store, clock, open, feed } = setup({});
  open("a.ts");
  feed(ev("overflow", "", null));
  await clock.advance(RELOAD_DEBOUNCE_MS + DELETE_SETTLE_MS);
  expect(store.get(W, "a.ts")!.external).toBe("deleted");
});

it("an event during a save is checked after the save lands", async () => {
  const { store, clock, read, open, feed } = setup({ "a.ts": text("mine", "h2") });
  open("a.ts");
  store.edit(W, "a.ts", "mine");
  store.setSaving(W, "a.ts", true);
  feed(ev("update", "a.ts"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(read).not.toHaveBeenCalled();
  // The save wrote "mine" with hash h2: the disk matches, so nothing is reloaded or marked.
  store.saved(W, "a.ts", "mine", "h2");
  await tick();
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.get(W, "a.ts")).toMatchObject({ text: "mine", hash: "h2", external: null });
});

it("reloadWithUndo drops the edits and offers Undo", async () => {
  const { api, store, open, io } = setup({ "a.ts": text("disk", "h2") });
  void api;
  open("a.ts");
  store.edit(W, "a.ts", "mine");
  await reloadWithUndo(io, W, "a.ts");
  expect(store.get(W, "a.ts")).toMatchObject({ text: "disk", saved: "disk", hash: "h2" });
  const toast = getToasts().at(-1)!;
  expect(toast.text).toBe("files.external.reloaded");
  toast.actions[0]!.run();
  expect(store.get(W, "a.ts")).toMatchObject({ text: "mine", saved: "one", hash: "h1", external: null });
});

it("reloadWithUndo of a clean file pushes no toast", async () => {
  const { store, open, io } = setup({ "a.ts": text("disk", "h2") });
  open("a.ts");
  const before = getToasts().length;
  await reloadWithUndo(io, W, "a.ts");
  expect(store.get(W, "a.ts")!.text).toBe("disk");
  expect(getToasts()).toHaveLength(before);
});

it("a create of an image marked deleted clears the mark and reloads the view", async () => {
  const { store, clock, read, feed } = setup({});
  store.open(W, "img/logo.png");
  feed(ev("delete", "img/logo.png", null));
  await clock.advance(DELETE_SETTLE_MS);
  expect(store.get(W, "img/logo.png")!.external).toBe("deleted");
  const before = store.get(W, "img/logo.png")!.version ?? 0;
  feed(ev("create", "img/logo.png"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(store.get(W, "img/logo.png")).toMatchObject({ external: null, version: before + 1 });
  // Bytes are read by the view, never as text here.
  expect(read).not.toHaveBeenCalled();
});

it("an update of an open image or media file reloads its view; an overflow leaves an unmarked one alone", async () => {
  const { store, clock, feed } = setup({});
  store.open(W, "a.png");
  store.open(W, "clip.mp4");
  feed(ev("update", "a.png"), ev("update", "clip.mp4"));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(store.get(W, "a.png")!.version).toBe(1);
  expect(store.get(W, "clip.mp4")!.version).toBe(1);
  // An overflow (focus, a restart) would reset zoom and replay media for nothing.
  feed(ev("overflow", "", null));
  await clock.advance(RELOAD_DEBOUNCE_MS);
  expect(store.get(W, "a.png")!.version).toBe(1);
});
