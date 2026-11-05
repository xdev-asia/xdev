import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import {
  CHANGE_LINE_CAP,
  changeChunks,
  changeChunksOf,
  changeCount,
  changeGutter,
  nextChangeLine,
  setChangeBase,
} from "./changeMarkers";

const lines = (...l: string[]) => l.join("\n");

it("added, modified and deleted chunks", () => {
  const base = lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "");
  const doc = lines("a", "B", "c", "d", "new1", "new2", "e", "f", "g", "i", "j", "");
  // b -> B modified (line 2); new1, new2 added (lines 5-6); h deleted (marker on line 10, the one after).
  expect(changeChunks(base, doc)).toEqual([
    { kind: "modified", fromLine: 2, toLine: 2 },
    { kind: "added", fromLine: 5, toLine: 6 },
    { kind: "deleted", fromLine: 10, toLine: 10 },
  ]);
});

it("a deletion at the end marks the last line", () => {
  expect(changeChunks(lines("a", "b", "c", ""), lines("a", "b", ""))).toEqual([{ kind: "deleted", fromLine: 3, toLine: 3 }]);
});

it("equal texts have no chunks, and line endings alone are not a change", () => {
  expect(changeChunks("a\nb\n", "a\nb\n")).toEqual([]);
  expect(changeChunks("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  expect(changeChunks("a\nb\n", "a\r\nb\r\n")).toEqual([]);
});

it("over the line cap gives no chunks", () => {
  const big = Array.from({ length: CHANGE_LINE_CAP + 1 }, (_, i) => `l${i}`).join("\n");
  expect(changeChunks(big, `x\n${big}`)).toEqual([]);
  expect(changeChunks(`x\n${big}`, big)).toEqual([]);
});

const CHUNKS = [
  { kind: "modified", fromLine: 2, toLine: 3 },
  { kind: "added", fromLine: 8, toLine: 8 },
  { kind: "deleted", fromLine: 12, toLine: 12 },
] as const;

it("next wraps to the first change", () => {
  expect(nextChangeLine(CHUNKS, 1, 1)).toBe(2);
  expect(nextChangeLine(CHUNKS, 2, 1)).toBe(8);
  expect(nextChangeLine(CHUNKS, 3, 1)).toBe(8);
  expect(nextChangeLine(CHUNKS, 12, 1)).toBe(2);
  expect(nextChangeLine(CHUNKS, 40, 1)).toBe(2);
});

it("previous wraps to the last change", () => {
  expect(nextChangeLine(CHUNKS, 20, -1)).toBe(12);
  expect(nextChangeLine(CHUNKS, 12, -1)).toBe(8);
  // From inside a chunk, previous leaves that chunk.
  expect(nextChangeLine(CHUNKS, 3, -1)).toBe(12);
  expect(nextChangeLine(CHUNKS, 2, -1)).toBe(12);
  expect(nextChangeLine(CHUNKS, 8, -1)).toBe(2);
});

it("no chunks means no line", () => {
  expect(nextChangeLine([], 1, 1)).toBeNull();
  expect(nextChangeLine([], 1, -1)).toBeNull();
});

it("no base means no chunks", () => {
  const state = EditorState.create({ doc: "a\nb", extensions: [changeGutter()] });
  expect(changeCount(state)).toBe(0);
  expect(changeChunksOf(state)).toEqual([]);
});

it("the gutter follows the base and the edits", () => {
  let state = EditorState.create({ doc: "a\nb\nc", extensions: [changeGutter()] });
  state = state.update({ effects: setChangeBase.of("a\nb\nc") }).state;
  expect(changeCount(state)).toBe(0);
  state = state.update({ changes: { from: 2, to: 3, insert: "X" } }).state;
  expect(changeChunksOf(state)).toEqual([{ kind: "modified", fromLine: 2, toLine: 2 }]);
  expect(changeCount(state)).toBe(1);
  // Typing it back removes the change.
  state = state.update({ changes: { from: 2, to: 3, insert: "b" } }).state;
  expect(changeCount(state)).toBe(0);
  // A new base recomputes against the current text.
  state = state.update({ effects: setChangeBase.of("other") }).state;
  expect(changeCount(state)).toBe(1);
  state = state.update({ effects: setChangeBase.of(null) }).state;
  expect(changeCount(state)).toBe(0);
});
