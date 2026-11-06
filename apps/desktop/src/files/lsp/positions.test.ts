import { Text } from "@codemirror/state";
import { expect, it } from "vitest";
import { fromLsp, lineStarts, offsetIn, toLsp } from "./positions";

const doc = Text.of(["ab", "😀x", "", "end"]);

it("converts offsets to positions and back", () => {
  expect(toLsp(doc, 0)).toEqual({ line: 0, character: 0 });
  expect(toLsp(doc, 4)).toEqual({ line: 1, character: 1 });
  for (const offset of [0, 2, 3, 5, 6, 7, doc.length]) expect(fromLsp(doc, toLsp(doc, offset))).toBe(offset);
});

it("counts an astral character as two units", () => {
  // The emoji is a surrogate pair, so x sits at column 2 of line 1.
  expect(toLsp(doc, 3 + 2)).toEqual({ line: 1, character: 2 });
  expect(fromLsp(doc, { line: 1, character: 2 })).toBe(5);
});

it("clamps a column past the line end and a line past the end", () => {
  expect(fromLsp(doc, { line: 0, character: 99 })).toBe(2);
  expect(fromLsp(doc, { line: 99, character: 0 })).toBe(doc.length);
  expect(fromLsp(doc, { line: -1, character: 3 })).toBe(0);
  expect(toLsp(doc, 999)).toEqual({ line: 3, character: 3 });
});

it("does the same on plain text", () => {
  const text = "ab\n😀x\n\nend";
  const starts = lineStarts(text);
  expect(starts).toEqual([0, 3, 7, 8]);
  expect(offsetIn(text, starts, { line: 1, character: 2 })).toBe(5);
  expect(offsetIn(text, starts, { line: 0, character: 99 })).toBe(2);
  expect(offsetIn(text, starts, { line: 9, character: 0 })).toBe(text.length);
  expect(offsetIn(text, starts, { line: 3, character: 99 })).toBe(text.length);
});
