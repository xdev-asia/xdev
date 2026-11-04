import { describe, expect, it } from "vitest";
import { recentSnapshot, sortEntries } from "./sidebarSort";

const e = (path: string) => ({ path });
const names = (list: { path: string }[]) => list.map((x) => x.path);

it("manual keeps the input order", () => {
  expect(names(sortEntries([e("a"), e("b"), e("c")], "manual", { a: 1, b: 3, c: 2 }))).toEqual(["a", "b", "c"]);
});

it("recent puts the latest output first", () => {
  expect(names(sortEntries([e("a"), e("b"), e("c")], "recent", { a: 1, b: 3, c: 2 }))).toEqual(["b", "c", "a"]);
});

it("recent keeps rows without activity at the end in input order", () => {
  expect(names(sortEntries([e("x"), e("a"), e("y"), e("b")], "recent", { a: 1, b: 2, y: null }))).toEqual(["b", "a", "x", "y"]);
  expect(names(sortEntries([e("x"), e("a")], "recent", undefined))).toEqual(["x", "a"]);
});

it("recent is stable for equal times", () => {
  expect(names(sortEntries([e("a"), e("b"), e("c")], "recent", { a: 5, b: 5, c: 5 }))).toEqual(["a", "b", "c"]);
});

it("does not change its input", () => {
  const input = [e("a"), e("b")];
  sortEntries(input, "recent", { b: 9 });
  expect(names(input)).toEqual(["a", "b"]);
});

describe("recentSnapshot", () => {
  const input = (over: Partial<Parameters<typeof recentSnapshot>[1]> = {}) => ({ sort: "recent" as const, paths: ["a", "b"], activity: { a: 1, b: 2 } as Record<string, number | null>, focus: 0, ...over });

  it("keeps the same snapshot while new output arrives", () => {
    const first = recentSnapshot(null, input());
    const next = recentSnapshot(first, input({ activity: { a: 9, b: 2 } }));
    expect(next).toBe(first);
    expect(names(sortEntries([e("a"), e("b")], "recent", next.activity))).toEqual(["b", "a"]);
  });

  it("takes a new snapshot when the sort preference changes", () => {
    const first = recentSnapshot(null, input({ sort: "manual" }));
    const next = recentSnapshot(first, input({ activity: { a: 9, b: 2 } }));
    expect(next).not.toBe(first);
    expect(next.activity).toEqual({ a: 9, b: 2 });
  });

  it("takes a new snapshot when a worktree is added or removed, whatever the path order", () => {
    const first = recentSnapshot(null, input());
    expect(recentSnapshot(first, input({ paths: ["b", "a"] }))).toBe(first);
    expect(recentSnapshot(first, input({ paths: ["a", "b", "c"], activity: { a: 1, b: 2, c: 3 } })).activity).toEqual({ a: 1, b: 2, c: 3 });
    expect(recentSnapshot(first, input({ paths: ["a"] }))).not.toBe(first);
  });

  it("takes a new snapshot when the window regains focus", () => {
    const first = recentSnapshot(null, input());
    const next = recentSnapshot(first, input({ focus: 1, activity: { a: 9, b: 2 } }));
    expect(next.activity).toEqual({ a: 9, b: 2 });
  });

  it("does not hold on to later changes of the activity object", () => {
    const live: Record<string, number | null> = { a: 1, b: 2 };
    const snap = recentSnapshot(null, input({ activity: live }));
    live.a = 50;
    expect(snap.activity.a).toBe(1);
  });
});
