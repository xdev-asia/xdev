import { expect, it } from "vitest";
import type { Note } from "@/api";
import { createMockPaneChrome, NOTE_BODY_MAX } from "./mockNotes";
import { createNotesStore } from "./notesStore";

const note = (tab: string, body: string): Note => ({ tab, worktree: "/w/oak", title: "Claude", body, updatedAt: 0 });
let clock = 1000;
const make = () => createMockPaneChrome(() => clock);

it("puts, gets and lists notes newest first, and sets the time itself", async () => {
  const api = make();
  expect(await api.notesList()).toEqual([]);
  const a = await api.notesPut(note("t1", "one"));
  await api.notesPut(note("t2", "two"));
  expect(a?.updatedAt).toBe(1000);
  expect((await api.notesList()).map((n) => n.tab)).toEqual(["t2", "t1"]);
  await api.notesPut(note("t1", "one again"));
  expect((await api.notesGet("t1"))?.body).toBe("one again");
  expect((await api.notesList()).map((n) => n.tab)).toEqual(["t1", "t2"]);
});

it("a blank body removes the note; delete removes one tab's", async () => {
  const api = make();
  await api.notesPut(note("t1", "x"));
  await api.notesPut(note("t2", "y"));
  expect(await api.notesPut(note("t1", "  \n"))).toBeNull();
  expect(await api.notesGet("t1")).toBeNull();
  await api.notesDelete("t2");
  expect(await api.notesList()).toEqual([]);
});

it("a body over 64 KB is refused as bad_note and the old note stays", async () => {
  const api = make();
  await api.notesPut(note("t1", "keep"));
  await expect(api.notesPut(note("t1", "a".repeat(NOTE_BODY_MAX + 1)))).rejects.toMatchObject({ code: "bad_note" });
  await expect(api.notesPut(note("", "x"))).rejects.toMatchObject({ code: "bad_note" });
  expect((await api.notesGet("t1"))?.body).toBe("keep");
});

it("the context read is unknown until a test sets it", async () => {
  const api = make();
  expect(await api.agentContextUsage("s1")).toBeNull();
  api.__contextUsage("s1", { tokens: 10, window: 100, model: null });
  expect(await api.agentContextUsage("s1")).toEqual({ tokens: 10, window: 100, model: null });
  api.__contextUsage("s1", null);
  expect(await api.agentContextUsage("s1")).toBeNull();
});

it("the store keeps the dot set in step with saves, blanks and removes", async () => {
  const api = make();
  await api.notesPut(note("seed", "from before"));
  const store = createNotesStore(api);
  store.load();
  await new Promise((r) => setTimeout(r, 0));
  expect([...store.state().byTab.keys()]).toEqual(["seed"]);
  await store.save(note("t1", "hello"));
  expect(store.state().byTab.get("t1")?.body).toBe("hello");
  expect(await store.save(note("t1", " "))).toBeNull();
  expect(store.state().byTab.has("t1")).toBe(false);
  await store.remove("seed");
  expect(store.state().byTab.size).toBe(0);
  await expect(store.save(note("t3", "a".repeat(NOTE_BODY_MAX + 1)))).rejects.toMatchObject({ code: "bad_note" });
  expect(store.state().byTab.has("t3")).toBe(false);
});

it("a list that fails leaves the store empty and loaded", async () => {
  const api = { ...make(), notesList: () => Promise.reject({ code: "io" }) };
  const store = createNotesStore(api);
  store.load();
  await new Promise((r) => setTimeout(r, 0));
  expect(store.state()).toEqual({ byTab: new Map(), loaded: true });
});
