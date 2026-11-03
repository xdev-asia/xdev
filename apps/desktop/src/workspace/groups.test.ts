import { expect, it } from "vitest";
import { groupOf, groupWorktrees, orderedWorktrees, worktreeTarget } from "./groups";
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
  { group: "needs-you" as const, items: [{ path: "/a" }, { path: "/b" }] },
  { group: "working" as const, items: [{ path: "/c" }] },
  { group: "rest" as const, items: [{ path: "/d" }, { path: "/e" }] },
];

it("orderedWorktrees follows the sidebar and skips collapsed groups", () => {
  expect(orderedWorktrees(sections)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  expect(orderedWorktrees(sections, ["working"])).toEqual(["/a", "/b", "/d", "/e"]);
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
  const order = orderedWorktrees(sections, ["needs-you"]);
  expect(worktreeTarget(order, "/c", { nth: 3 })).toBe("/e");
  expect(worktreeTarget(order, "/c", { nth: 4 })).toBeNull();
});

it("worktreeTarget with no worktrees does nothing", () => {
  expect(worktreeTarget([], null, { step: 1 })).toBeNull();
  expect(worktreeTarget([], null, { nth: 1 })).toBeNull();
});
