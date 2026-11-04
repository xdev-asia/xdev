import { expect, it } from "vitest";
import { parseConflicts, resolveBlock } from "./conflictMarkers";

const merged = ["a", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "z", ""].join("\n");

it("finds a block and its three parts", () => {
  expect(parseConflicts(merged)).toEqual([{ start: 1, mid: 3, end: 5 }]);
});

it("finds several blocks in order", () => {
  const two = merged + merged;
  expect(parseConflicts(two).map((b) => [b.start, b.end])).toEqual([[1, 5], [8, 12]]);
});

it("knows the diff3 base section", () => {
  const text = ["<<<<<<< HEAD", "ours", "||||||| base", "old", "=======", "theirs", ">>>>>>> x"].join("\n");
  expect(parseConflicts(text)).toEqual([{ start: 0, base: 2, mid: 4, end: 6 }]);
  expect(resolveBlock(text, parseConflicts(text)[0], "current")).toBe("ours");
  expect(resolveBlock(text, parseConflicts(text)[0], "incoming")).toBe("theirs");
});

it("needs exactly seven characters at the start of the line", () => {
  expect(parseConflicts(["<<<<<<<< a", "=======", ">>>>>>> b"].join("\n"))).toEqual([]);
  expect(parseConflicts([" <<<<<<< a", "=======", ">>>>>>> b"].join("\n"))).toEqual([]);
  expect(parseConflicts(["<<<<<<< a", "========", ">>>>>>> b"].join("\n"))).toEqual([]);
});

it("ignores a block that never closes and a stray divider", () => {
  expect(parseConflicts(["<<<<<<< a", "x", "=======", "y"].join("\n"))).toEqual([]);
  expect(parseConflicts(["x", "=======", "y"].join("\n"))).toEqual([]);
  expect(parseConflicts(["<<<<<<< a", "x", ">>>>>>> b"].join("\n"))).toEqual([]);
});

it("restarts at a new opening marker inside an open block", () => {
  const text = ["<<<<<<< a", "lost", "<<<<<<< b", "x", "=======", "y", ">>>>>>> c"].join("\n");
  expect(parseConflicts(text)).toEqual([{ start: 2, mid: 4, end: 6 }]);
});

it("resolves to current, incoming or both and leaves the rest alone", () => {
  const [block] = parseConflicts(merged);
  expect(resolveBlock(merged, block, "current")).toBe("a\nours\nz\n");
  expect(resolveBlock(merged, block, "incoming")).toBe("a\ntheirs\nz\n");
  expect(resolveBlock(merged, block, "both")).toBe("a\nours\ntheirs\nz\n");
});

it("keeps CRLF line endings", () => {
  const text = merged.replace(/\n/g, "\r\n");
  const [block] = parseConflicts(text);
  expect(block).toEqual({ start: 1, mid: 3, end: 5 });
  expect(resolveBlock(text, block, "both")).toBe("a\r\nours\r\ntheirs\r\nz\r\n");
});

it("does not add a line ending when the closing marker was the last line", () => {
  const text = ["<<<<<<< a", "x", "=======", "y", ">>>>>>> b"].join("\n");
  expect(resolveBlock(text, parseConflicts(text)[0], "incoming")).toBe("y");
});

it("resolves an empty side", () => {
  const text = ["<<<<<<< a", "=======", "y", ">>>>>>> b", ""].join("\n");
  expect(resolveBlock(text, parseConflicts(text)[0], "current")).toBe("");
  expect(resolveBlock(text, parseConflicts(text)[0], "both")).toBe("y\n");
});

it("finds a real block inside a markdown code fence", () => {
  const text = ["# Doc", "```js", "<<<<<<< a", "x", "=======", "y", ">>>>>>> b", "```", ""].join("\n");
  expect(parseConflicts(text)).toEqual([{ start: 2, mid: 4, end: 6 }]);
});

it("a block whose sides edit fence lines still counts", () => {
  const text = ["<<<<<<< HEAD", "```js", "=======", "```ts", ">>>>>>> b", "", "<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> b", ""].join("\n");
  expect(parseConflicts(text).map((b) => b.start)).toEqual([0, 6]);
});
