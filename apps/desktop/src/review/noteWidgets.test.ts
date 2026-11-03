import { EditorSelection, EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { NOTE_KEYS, rangeFromSelection, rangeOfLines } from "./noteWidgets";

const doc = "one\ntwo\nthree\nfour\nfive\nsix\n";
const at = (anchor: number, head = anchor) => EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });

it("a cursor is one line", () => {
  expect(rangeFromSelection(at(5))).toEqual({ startLine: 2, line: 2, anchor: "two" });
});

it("a selection over lines 3 to 5 is that range, with its text as the anchor", () => {
  const from = doc.indexOf("three") + 2;
  const to = doc.indexOf("five") + 2;
  expect(rangeFromSelection(at(from, to))).toEqual({ startLine: 3, line: 5, anchor: "three\nfour\nfive" });
  // A backwards selection reads the same.
  expect(rangeFromSelection(at(to, from))).toMatchObject({ startLine: 3, line: 5 });
});

it("a selection that ends at the start of a line stops on the line before", () => {
  const from = doc.indexOf("three");
  const to = doc.indexOf("five");
  expect(rangeFromSelection(at(from, to))).toMatchObject({ startLine: 3, line: 4 });
});

it("the range keeps the whole text; newNote bounds it", () => {
  const state = EditorState.create({ doc: "x".repeat(5000) });
  expect(rangeOfLines(state, 1, 1).anchor).toHaveLength(5000);
});

it("only c with no modifier and Ctrl+Shift+A open a note", () => {
  expect(NOTE_KEYS).toEqual(["c", "Ctrl-Shift-a"]);
  expect(NOTE_KEYS).not.toContain("Ctrl-c");
});
