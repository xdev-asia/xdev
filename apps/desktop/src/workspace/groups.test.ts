import { expect, it } from "vitest";
import type { PrState, RepoView, WorkStatus } from "@/api";
import { groupBy, groupOf, groupWorktrees, orderedWorktrees, worktreeTarget } from "./groups";
import type { TabStatus } from "./status";

it("groups map done to review and idle to rest", () => {
  expect(groupOf("needs-you")).toBe("needs-you");
  expect(groupOf("failed")).toBe("needs-you");
  expect(groupOf("working")).toBe("working");
  expect(groupOf("done")).toBe("review");
  expect(groupOf("idle")).toBe("rest");
  expect(groupOf("exited")).toBe("rest");
  expect(groupOf(null)).toBe("rest");
});

it("keeps input order inside a group and drops empty groups", () => {
  const dots: Record<string, TabStatus | null> = { a: "done", b: "working", c: null, d: "working", e: "done", f: "exited" };
  const items = ["a", "b", "c", "d", "e", "f"].map((path) => ({ path }));
  const grouped = groupWorktrees(items, (p) => dots[p] ?? null);
  expect(grouped.map((g) => g.group)).toEqual(["working", "review", "rest"]);
  expect(grouped.map((g) => g.items.map((i) => i.path))).toEqual([["b", "d"], ["a", "e"], ["c", "f"]]);
  expect(groupWorktrees([], () => null)).toEqual([]);
});


const sections = [
  { key: "activity:needs-you", items: [{ path: "/a" }, { path: "/b" }] },
  { key: "activity:working", items: [{ path: "/c" }] },
  { key: "activity:rest", items: [{ path: "/d" }, { path: "/e" }] },
];

it("orderedWorktrees follows the sidebar and skips collapsed groups", () => {
  expect(orderedWorktrees(sections)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  expect(orderedWorktrees(sections, ["activity:working"])).toEqual(["/a", "/b", "/d", "/e"]);
  expect(orderedWorktrees([])).toEqual([]);
});

it("worktreeTarget wraps from the last worktree to the first and back", () => {
  const order = orderedWorktrees(sections);
  expect(worktreeTarget(order, "/e", { step: 1 })).toBe("/a");
  expect(worktreeTarget(order, "/a", { step: -1 })).toBe("/e");
  expect(worktreeTarget(order, "/b", { step: 1 })).toBe("/c");
  expect(worktreeTarget(order, null, { step: 1 })).toBe("/a");
  expect(worktreeTarget(order, "/gone", { step: -1 })).toBe("/a");
});

it("worktreeTarget picks the Nth visible one, skipping collapsed groups", () => {
  const order = orderedWorktrees(sections, ["activity:needs-you"]);
  expect(worktreeTarget(order, "/c", { nth: 3 })).toBe("/e");
  expect(worktreeTarget(order, "/c", { nth: 4 })).toBeNull();
});

it("worktreeTarget with no worktrees does nothing", () => {
  expect(worktreeTarget([], null, { step: 1 })).toBeNull();
  expect(worktreeTarget([], null, { nth: 1 })).toBeNull();
});

const repo = (id: string) => ({ id, shortName: id }) as unknown as RepoView;
const ent = (path: string, repoId: string, status: WorkStatus | null = null) => ({ path, repo: repo(repoId), wt: { path, status } });
const DOTS: Record<string, TabStatus> = { a: "working", b: "done" };
const PRS: Record<string, PrState> = { a: "open", b: "merged", c: "open" };
const ctx = { dotOf: (p: string) => DOTS[p] ?? null, prOf: (p: string) => PRS[p] ?? null };
const list = [ent("a", "r1", "in-review"), ent("b", "r2", "todo"), ent("c", "r1"), ent("d", "r2", "todo")];
const shape = (s: { key: string; items: { path: string }[] }[]) => s.map((x) => [x.key, x.items.map((i) => i.path)]);

it("groupBy activity is the agent sections with prefixed keys", () => {
  expect(shape(groupBy(list, "activity", ctx))).toEqual([
    ["activity:working", ["a"]],
    ["activity:review", ["b"]],
    ["activity:rest", ["c", "d"]],
  ]);
});

it("groupBy none gives one unnamed section", () => {
  expect(shape(groupBy(list, "none", ctx))).toEqual([["none", ["a", "b", "c", "d"]]]);
  expect(groupBy([], "none", ctx)).toEqual([]);
});

it("groupBy status follows the work statuses, then no status; empty groups are left out", () => {
  expect(shape(groupBy(list, "status", ctx))).toEqual([
    ["status:todo", ["b", "d"]],
    ["status:in-review", ["a"]],
    ["status:none", ["c"]],
  ]);
});

it("groupBy pr follows the pull request state, then none", () => {
  expect(shape(groupBy(list, "pr", ctx))).toEqual([
    ["pr:open", ["a", "c"]],
    ["pr:merged", ["b"]],
    ["pr:none", ["d"]],
  ]);
});

it("groupBy project has one section per repo in first-seen order", () => {
  const s = groupBy([ent("x", "r2"), ent("y", "r1"), ent("z", "r2")], "project", ctx);
  expect(shape(s)).toEqual([["project:r2", ["x", "z"]], ["project:r1", ["y"]]]);
  expect(s[0].repo?.id).toBe("r2");
});

it("orderedWorktrees follows the drawn order in every mode", () => {
  for (const mode of ["activity", "none", "status", "pr", "project"] as const) {
    const s = groupBy(list, mode, ctx);
    expect(orderedWorktrees(s)).toEqual(s.flatMap((x) => x.items.map((i) => i.path)));
    expect(orderedWorktrees(s, [s[0].key])).toEqual(s.slice(1).flatMap((x) => x.items.map((i) => i.path)));
  }
});
