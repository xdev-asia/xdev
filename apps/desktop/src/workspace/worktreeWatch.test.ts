import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type FsChanged, type FsEvent } from "@/api";
import { FileTabs } from "@/files/fileTabs";
import { needsChoice } from "@/files/ExternalChangeBanner";
import { RELOAD_DEBOUNCE_MS, resetWatchState } from "@/files/fileWatch";
import { fakeTimers, tick } from "@/files/testClock";
import { RETRY_MAX_MS, WorktreeWatch, type WatchHealth } from "./worktreeWatch";

const W = "/demo/wt/xdev-oak";
const t = (k: string) => k;
const OVERFLOW: FsEvent = { kind: "overflow", rel: "", dir: null };
const text = (body: string, hash: string) => ({ rel: "x", text: body, kind: "text" as const, size: body.length, hash, eol: "lf" as const });

function setup() {
  const api = createMockApi({});
  const store = new FileTabs();
  const io = { api, store, t };
  const batches: FsEvent[][] = [];
  const health: WatchHealth[] = [];
  let send: ((c: FsChanged) => void) | null = null;
  const watch = vi.spyOn(api, "filesWatch").mockImplementation(async (_w, _id, on) => void (send = on));
  const clock = fakeTimers();
  const make = () => new WorktreeWatch({ api, worktree: W, io: () => io, onBatch: (e) => batches.push(e), onHealth: (h) => health.push(h), timers: clock.timers });
  return { api, store, io, batches, health, watch, make, clock, send: (c: FsChanged) => send!(c) };
}

beforeEach(() => resetWatchState());

it("a start refused for the watch limit says so", async () => {
  const s = setup();
  s.watch.mockRejectedValueOnce({ code: "watch_limit" });
  const w = s.make();
  w.start();
  await tick();
  expect(s.health.at(-1)).toBe<WatchHealth>("limit");
  w.stop();
});

it("a watcher that stops at the watch limit says so, and the batch still reaches the tree", async () => {
  const s = setup();
  const w = s.make();
  w.start();
  await tick();
  expect(s.health.at(-1)).toBe<WatchHealth>("live");
  s.send({ worktree: W, events: [{ kind: "overflow", rel: "", dir: null }], failure: "watchLimit" });
  expect(s.health.at(-1)).toBe<WatchHealth>("limit");
  expect(s.batches.at(-1)).toEqual([{ kind: "overflow", rel: "", dir: null }]);
  w.stop();
});

it("a watcher that failed is started again after a backoff, and everything is read again", async () => {
  const s = setup();
  const read = vi.spyOn(s.api, "fileRead").mockResolvedValue(text("disk", "h2"));
  s.store.open(W, "a.ts");
  s.store.loaded(W, "a.ts", text("one", "h1"));
  const w = s.make();
  w.start();
  await tick();
  s.send({ worktree: W, events: [OVERFLOW], failure: "failed" });
  expect(s.health.at(-1)).toBe<WatchHealth>("off");
  await s.clock.advance(999);
  expect(s.watch).toHaveBeenCalledTimes(1);
  await s.clock.advance(1);
  expect(s.watch).toHaveBeenCalledTimes(2);
  // The same subscription id: the backend replaces it and starts a new watcher.
  expect(s.watch.mock.calls[1]![1]).toBe(s.watch.mock.calls[0]![1]);
  expect(s.health.at(-1)).toBe<WatchHealth>("live");
  // What changed while nothing watched: the tree reads again, the open file is checked.
  expect(s.batches.at(-1)).toEqual([OVERFLOW]);
  read.mockClear();
  await s.clock.advance(RELOAD_DEBOUNCE_MS);
  expect(read).toHaveBeenCalledWith(W, "a.ts");
  expect(s.store.get(W, "a.ts")!.text).toBe("disk");
  w.stop();
});

it("restarts back off 1 s, 2 s, 4 s ... up to a minute, and a working watch resets that", async () => {
  const s = setup();
  s.watch.mockRejectedValue({ code: "io" });
  const w = s.make();
  w.start();
  await tick();
  const times: number[] = [];
  let calls = 1;
  while (times.length < 9 && s.clock.now() < 400000) {
    await s.clock.advance(100);
    if (s.watch.mock.calls.length > calls) {
      calls = s.watch.mock.calls.length;
      times.push(s.clock.now());
    }
  }
  const gaps = times.map((at, i) => at - (i === 0 ? 0 : times[i - 1]!));
  expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  expect(RETRY_MAX_MS).toBe(60000);
  // It works again and a normal batch arrives: the next failure waits 1 s again.
  let send: ((c: FsChanged) => void) | null = null;
  s.watch.mockImplementation(async (_w, _id, on) => void (send = on));
  await s.clock.advance(60000);
  send!({ worktree: W, events: [{ kind: "update", rel: "x", dir: false }], failure: null });
  const before = s.watch.mock.calls.length;
  send!({ worktree: W, events: [OVERFLOW], failure: "failed" });
  await s.clock.advance(1000);
  expect(s.watch.mock.calls.length).toBe(before + 1);
  w.stop();
});

it("the watch limit is retried too; an unknown worktree is not", async () => {
  const s = setup();
  s.watch.mockRejectedValueOnce({ code: "watch_limit" });
  const w = s.make();
  w.start();
  await tick();
  await s.clock.advance(1000);
  expect(s.watch).toHaveBeenCalledTimes(2);
  expect(s.health.at(-1)).toBe<WatchHealth>("live");
  w.stop();

  const u = setup();
  u.watch.mockRejectedValue({ code: "worktree_unknown" });
  const gone = u.make();
  gone.start();
  await tick();
  await u.clock.advance(120000);
  expect(u.watch).toHaveBeenCalledTimes(1);
  gone.stop();
});

it("a stopped watch is not restarted", async () => {
  const s = setup();
  const w = s.make();
  w.start();
  await tick();
  s.send({ worktree: W, events: [OVERFLOW], failure: "failed" });
  w.stop();
  await s.clock.advance(120000);
  expect(s.watch).toHaveBeenCalledTimes(1);
});

it("recheck reads the open files and the tree again (the window got focus)", async () => {
  const s = setup();
  const read = vi.spyOn(s.api, "fileRead").mockResolvedValue(text("disk", "h2"));
  s.store.open(W, "a.ts");
  s.store.loaded(W, "a.ts", text("one", "h1"));
  const w = s.make();
  w.start();
  await tick();
  w.recheck();
  expect(s.batches.at(-1)).toEqual([OVERFLOW]);
  await s.clock.advance(RELOAD_DEBOUNCE_MS);
  expect(read).toHaveBeenCalledWith(W, "a.ts");
  expect(s.store.get(W, "a.ts")!.text).toBe("disk");
  w.stop();
});

it("open files changed while another worktree was shown are read when it shows again", async () => {
  const s = setup();
  const OTHER = "/demo/wt/xdev-elm";
  const disk: Record<string, ReturnType<typeof text>> = { "clean.ts": text("one", "h1"), "dirty.ts": text("one", "h1") };
  vi.spyOn(s.api, "fileRead").mockImplementation(async (_w, rel) => disk[rel]!);
  for (const rel of ["clean.ts", "dirty.ts"]) {
    s.store.open(W, rel);
    s.store.loaded(W, rel, text("one", "h1"));
  }
  s.store.edit(W, "dirty.ts", "mine");
  const first = s.make();
  first.start();
  await tick();
  await s.clock.advance(RELOAD_DEBOUNCE_MS);
  // Another worktree is shown: nobody watches this one.
  first.stop();
  const other = new WorktreeWatch({ api: s.api, worktree: OTHER, io: () => s.io, onBatch() {}, onHealth() {}, timers: s.clock.timers });
  other.start();
  await tick();
  disk["clean.ts"] = text("two", "h2");
  disk["dirty.ts"] = text("theirs", "h3");
  other.stop();
  // Back: the new subscription reads the open files.
  const again = s.make();
  again.start();
  await tick();
  await s.clock.advance(RELOAD_DEBOUNCE_MS);
  expect(s.store.get(W, "clean.ts")).toMatchObject({ text: "two", external: null });
  const dirty = s.store.get(W, "dirty.ts")!;
  expect(dirty).toMatchObject({ text: "mine", external: "changed" });
  expect(needsChoice(dirty)).toBe(true);
  again.stop();
});
