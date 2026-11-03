import { expect, it } from "vitest";
import { groupOf, groupWorktrees } from "./groups";
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
