import { expect, it } from "vitest";
import { sortEntries } from "./sidebarSort";

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
