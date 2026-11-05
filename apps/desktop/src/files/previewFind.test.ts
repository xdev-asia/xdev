import { expect, it } from "vitest";
import { findMatches, stepMatch } from "./previewFind";

it("finds case-insensitive, non-overlapping matches per text node", () => {
  expect(findMatches(["Foo foo", "none", "aaa"], "FOO")).toEqual([
    { node: 0, start: 0, end: 3 },
    { node: 0, start: 4, end: 7 },
  ]);
  expect(findMatches(["aaa"], "aa")).toEqual([{ node: 0, start: 0, end: 2 }]);
});

it("an empty query matches nothing", () => {
  expect(findMatches(["abc"], "")).toEqual([]);
});

it("steps with wrap-around and gives -1 without matches", () => {
  expect(stepMatch(0, 3, 1)).toBe(1);
  expect(stepMatch(2, 3, 1)).toBe(0);
  expect(stepMatch(0, 3, -1)).toBe(2);
  expect(stepMatch(0, 0, 1)).toBe(-1);
});
