import { expect, it } from "vitest";
import { reviewRows } from "./reviewRows";

const file = (path: string, staged: boolean, unstaged: boolean) => ({ path, kind: "modified" as const, staged, unstaged });

it("a folder shows the changed dot only when it holds an unstaged file", () => {
  const rows = reviewRows([file("a/x.ts", true, false), file("b/y.ts", false, true), file("b/c/z.ts", true, false)], new Set());
  const dir = (id: string) => rows.find((r) => r.id === id)!;
  expect(dir("a/").changed).toBeUndefined();
  expect(dir("b/").changed).toBe(true);
  expect(dir("b/c/").changed).toBeUndefined();
});

it("a file keeps its status letter whether it is staged or not", () => {
  const rows = reviewRows([file("a/x.ts", true, false), file("a/y.ts", false, true)], new Set());
  expect(rows.filter((r) => r.kind === "file").map((r) => r.mark)).toEqual(["modified", "modified"]);
});

it("a partly staged file counts as unstaged", () => {
  expect(reviewRows([file("a/x.ts", true, true)], new Set())[0].changed).toBe(true);
});
