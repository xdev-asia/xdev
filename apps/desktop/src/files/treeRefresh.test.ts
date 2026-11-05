import { expect, it } from "vitest";
import type { FsEvent } from "@/api";
import { MAX_QUEUED, dirsToReload, drain, emptyQueue, enqueue } from "./treeRefresh";

const ev = (kind: FsEvent["kind"], rel: string, dir: boolean | null = false): FsEvent => ({ kind, rel, dir });
const LOADED = new Set(["", "src", "src/deep"]);

it("a root entry reloads the root", () => {
  expect(dirsToReload([ev("create", "a.txt")], LOADED)).toEqual([""]);
});

it("a nested entry reloads its parent only when that folder is loaded", () => {
  expect(dirsToReload([ev("delete", "src/deep/x.ts", null)], LOADED)).toEqual(["src/deep"]);
  expect(dirsToReload([ev("create", "docs/new.md")], LOADED)).toEqual([]);
});

it("a created or deleted folder reloads its parent", () => {
  expect(dirsToReload([ev("create", "src/lib", true)], LOADED)).toEqual(["src"]);
});

it("an update to a file reloads nothing", () => {
  expect(dirsToReload([ev("update", "src/a.ts")], LOADED)).toEqual([]);
});

it("an overflow reloads everything", () => {
  expect(dirsToReload([ev("create", "a"), ev("overflow", "", null)], LOADED)).toBe("all");
});

it("a folder is listed once", () => {
  const out = dirsToReload([ev("create", "src/a.ts"), ev("delete", "src/b.ts", null), ev("create", "c")], LOADED);
  expect(out).toEqual(["src", ""]);
});

it("enqueue keeps every batch in order, numbered, as a new queue", () => {
  const q0 = emptyQueue("/w");
  const q1 = enqueue(q0, [ev("create", "a")]);
  const q2 = enqueue(q1, [ev("create", "b")]);
  expect(q0.batches).toEqual([]);
  expect(q2.batches.map((b) => b.events[0]!.rel)).toEqual(["a", "b"]);
  expect(q2.batches[1]!.seq).toBeGreaterThan(q2.batches[0]!.seq);
});

it("drain hands over each batch once, in order", () => {
  let q = enqueue(enqueue(emptyQueue("/w"), [ev("create", "a")]), [ev("delete", "b", null)]);
  const first = drain(q, "/w", 0);
  expect(first.events.map((e) => e.rel)).toEqual(["a", "b"]);
  expect(drain(q, "/w", first.seen).events).toEqual([]);
  q = enqueue(q, [ev("create", "c")]);
  expect(drain(q, "/w", first.seen).events.map((e) => e.rel)).toEqual(["c"]);
});

it("drain ignores the queue of another worktree", () => {
  const q = enqueue(emptyQueue("/other"), [ev("create", "a")]);
  expect(drain(q, "/w", 0)).toEqual({ events: [], seen: 0 });
});

it("batches dropped from a full queue become an overflow for a reader that missed them", () => {
  let q = emptyQueue("/w");
  q = enqueue(q, [ev("create", "first")]);
  const seen = drain(q, "/w", 0).seen;
  for (let i = 0; i < MAX_QUEUED + 5; i++) q = enqueue(q, [ev("create", `f${i}`)]);
  expect(q.batches).toHaveLength(MAX_QUEUED);
  expect(drain(q, "/w", seen).events[0]!.kind).toBe("overflow");
  // A reader that saw the last kept batch misses nothing.
  const last = q.batches.at(-1)!.seq;
  expect(drain(q, "/w", last).events).toEqual([]);
});
