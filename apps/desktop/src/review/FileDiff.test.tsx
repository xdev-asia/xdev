import { expect, it } from "vitest";
import type { WorktreeFileDiff } from "@/api";
import { keepSame } from "./FileDiff";

const diff = (old: string, next: string, skip: WorktreeFileDiff["skip"] = null): WorktreeFileDiff => ({ old, new: next, skip }) as WorktreeFileDiff;

it("a reload with the same text keeps the same diff object, so the editors stay", () => {
  const first = diff("a", "b");
  expect(keepSame(first, diff("a", "b"))).toBe(first);
  const changed = diff("a", "c");
  expect(keepSame(first, changed)).toBe(changed);
  expect(keepSame(null, first)).toBe(first);
  const skipped = diff("a", "b", "binary");
  expect(keepSame(first, skipped)).toBe(skipped);
});
