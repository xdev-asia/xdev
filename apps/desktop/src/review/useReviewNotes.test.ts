import { afterEach, expect, it, vi } from "vitest";
import { createMockApi, type Api, type ReviewNote } from "@/api";
import { newNote } from "./notes";
import { NotesStore, UNDO_MS } from "./useReviewNotes";

const OAK = "/demo/wt/xdev-oak";
const text = (...lines: string[]) => lines.join("\n") + "\n";

afterEach(() => vi.useRealTimers());

function store(api: Api = createMockApi({})) {
  const put = vi.spyOn(api, "reviewNotesPut");
  const s = new NotesStore(api, OAK, () => 100);
  return { api, put, s, notes: () => s.snapshot().notes };
}

it("adds, edits and puts each change once; an empty body is ignored", async () => {
  const { s, put, notes } = store();
  await s.load();
  await s.add("a.ts", 3, 3, "target", "  fix  ");
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatchObject({ file: "a.ts", startLine: 3, body: "fix", createdAt: 100, sentAt: null });
  await s.add("a.ts", 4, 4, "x", "   ");
  expect(put).toHaveBeenCalledTimes(1);
  await s.markSent([notes()[0].id]);
  expect(notes()[0].sentAt).toBe(100);
  await s.edit(notes()[0].id, "again");
  expect(notes()[0]).toMatchObject({ body: "again", sentAt: null });
  expect(put).toHaveBeenCalledTimes(3);
});

it("keeps the notes across a new store on the same worktree", async () => {
  const { api, s } = store();
  await s.load();
  await s.add("a.ts", 1, 1, "x", "keep me");
  const again = new NotesStore(api, OAK);
  await again.load();
  expect(again.snapshot()).toMatchObject({ loaded: true, notes: [{ body: "keep me" }] });
});

it("delete then Undo brings the note back, and Undo goes away after five seconds", async () => {
  vi.useFakeTimers();
  const { s, notes } = store();
  await s.load();
  await s.add("a.ts", 1, 1, "x", "one");
  const id = notes()[0].id;
  await s.remove(id);
  expect(notes()).toHaveLength(0);
  expect(s.snapshot().removed?.id).toBe(id);
  await s.undo();
  expect(notes().map((n) => n.id)).toEqual([id]);
  expect(s.snapshot().removed).toBeNull();

  await s.remove(id);
  vi.advanceTimersByTime(UNDO_MS + 1);
  expect(s.snapshot().removed).toBeNull();
  await s.undo();
  expect(notes()).toHaveLength(0);
});

it("re-anchoring puts once when something moved and not at all otherwise", async () => {
  const { s, put, notes } = store();
  await s.load();
  await s.add("a.ts", 3, 3, "target", "n");
  put.mockClear();
  await s.reanchorFile("a.ts", text("x", "y", "target"));
  expect(put).not.toHaveBeenCalled();
  await s.reanchorFile("a.ts", text("new", "x", "y", "target"));
  expect(notes()[0]).toMatchObject({ startLine: 4, line: 4, outdated: false });
  expect(put).toHaveBeenCalledTimes(1);
  await s.reanchorFile("a.ts", text("new", "x", "y", "changed"));
  expect(notes()[0].outdated).toBe(true);
  await s.reanchorFile("other.ts", text("whatever"));
  expect(put).toHaveBeenCalledTimes(2);
});

it("a failed put restores the list and says why", async () => {
  const { s, put, notes } = store();
  await s.load();
  put.mockRejectedValueOnce({ code: "bad_note" });
  await s.add("a.ts", 1, 1, "x", "nope");
  expect(notes()).toHaveLength(0);
  expect(s.snapshot().problem).toMatchObject({ code: "bad_note" });
  await s.add("a.ts", 1, 1, "x", "fine");
  expect(notes()).toHaveLength(1);
  expect(s.snapshot().problem).toBeNull();
});

it("tells subscribers and reads a failed load as a problem", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "reviewNotes").mockRejectedValueOnce({ code: "worktree_unknown" });
  const s = new NotesStore(api, OAK);
  const seen = vi.fn();
  const off = s.subscribe(seen);
  await s.load();
  expect(seen).toHaveBeenCalled();
  expect(s.snapshot()).toMatchObject({ loaded: true, problem: { code: "worktree_unknown" } });
  off();
  const calls = seen.mock.calls.length;
  await s.add("a.ts", 1, 1, "x", "y");
  expect(seen.mock.calls.length).toBe(calls);
});

it("unused type keeps the import honest", () => {
  const n: ReviewNote = newNote("a.ts", 1, 1, "x", "b", 1, "id");
  expect(n.id).toBe("id");
});

it("writes nothing while the load failed, so earlier notes are not wiped", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "reviewNotes").mockRejectedValueOnce({ code: "io" });
  const put = vi.spyOn(api, "reviewNotesPut");
  const s = new NotesStore(api, OAK);
  await s.load();
  await s.add("a.ts", 1, 1, "x", "new");
  await s.markSent(["nope"]);
  await s.reanchorFile("a.ts", null);
  expect(put).not.toHaveBeenCalled();
  expect(s.snapshot()).toMatchObject({ notes: [], problem: { code: "io" } });
});

it("writes nothing before the load has returned", async () => {
  const api = createMockApi({});
  const put = vi.spyOn(api, "reviewNotesPut");
  const s = new NotesStore(api, OAK);
  const loading = s.load();
  await s.add("a.ts", 1, 1, "x", "early");
  expect(put).not.toHaveBeenCalled();
  await loading;
  await s.add("a.ts", 1, 1, "x", "late");
  expect(put).toHaveBeenCalledTimes(1);
});

it("a later good load makes writes possible again", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "reviewNotes").mockRejectedValueOnce({ code: "io" });
  const s = new NotesStore(api, OAK);
  await s.load();
  await s.load();
  expect(s.snapshot().problem).toBeNull();
  await s.add("a.ts", 1, 1, "x", "ok");
  expect(s.snapshot().notes).toHaveLength(1);
});
