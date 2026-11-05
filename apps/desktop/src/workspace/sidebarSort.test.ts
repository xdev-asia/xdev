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

describe("name, smart and project", () => {
  type R = { path: string; wt?: { name: string; title?: string | null }; repo?: { shortName: string } };
  const r = (path: string, name: string, title: string | null = null, repo = "xdev"): R => ({ path, wt: { name, title }, repo: { shortName: repo } });

  it("name uses the title else the name, ignoring case and accents, digits as numbers", () => {
    const list = [r("/3", "wt-10"), r("/2", "wt-2"), r("/1", "zeta", "Émile"), r("/4", "Apple")];
    expect(names(sortEntries(list, "name", undefined))).toEqual(["/4", "/1", "/2", "/3"]);
  });

  it("name breaks ties by path and is stable", () => {
    expect(names(sortEntries([r("/b", "same"), r("/a", "same")], "name", undefined))).toEqual(["/a", "/b"]);
    expect(names(sortEntries([r("/x", "same"), r("/x", "SAME")], "name", undefined))).toEqual(["/x", "/x"]);
  });

  it("smart orders by class, then newest activity, then name", () => {
    const list = [r("/idle", "idle"), r("/work", "work"), r("/done", "done"), r("/need", "need"), r("/fail", "fail"), r("/old", "old"), r("/none", "none")];
    const status: Record<string, string> = { "/idle": "idle", "/work": "working", "/done": "done", "/need": "needs-you", "/fail": "failed", "/old": "exited" };
    const activity = { "/need": 1, "/fail": 5, "/idle": 3, "/old": 9 };
    expect(names(sortEntries(list, "smart", activity, (p) => status[p]))).toEqual(["/fail", "/need", "/done", "/work", "/old", "/idle", "/none"]);
  });

  it("smart falls back to name when activity ties", () => {
    expect(names(sortEntries([r("/b", "b"), r("/a", "a")], "smart", {}, () => null))).toEqual(["/a", "/b"]);
  });

  it("project sorts by repo short name, then name", () => {
    const list = [r("/1", "b", null, "zed"), r("/2", "b", null, "Alpha"), r("/3", "a", null, "zed")];
    expect(names(sortEntries(list, "project", undefined))).toEqual(["/2", "/3", "/1"]);
  });

  it("rows without a worktree sort by path", () => {
    expect(names(sortEntries([e("/b"), e("/a")], "name", undefined))).toEqual(["/a", "/b"]);
  });

  it("the snapshot covers smart but not name", () => {
    const base = { paths: ["a"], activity: { a: 1 }, focus: 0 };
    expect(recentSnapshot(null, { ...base, sort: "smart" }).activity).toEqual({ a: 1 });
    expect(recentSnapshot(null, { ...base, sort: "name" }).activity).toEqual({});
  });
});
