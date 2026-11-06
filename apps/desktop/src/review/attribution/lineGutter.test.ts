import { EditorState, type RangeSet } from "@codemirror/state";
import { expect, it } from "vitest";
import type { LineAttribution } from "@/api";
import { translate } from "@/i18n";
import { AuthorMarker, lineAuthorsField, setLineAuthors } from "./lineGutter";

const strings = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const attr: LineAttribution = {
  lines: 5,
  authors: [
    { kind: "agent", tabId: "t1", agent: "claude", at: 1000 },
    { kind: "outside", tabId: null, agent: null, at: null },
  ],
  runs: [
    { from: 2, to: 3, author: 0 },
    { from: 5, to: 5, author: 1 },
  ],
};

function marked(state: EditorState): Array<[number, number]> {
  const set: RangeSet<AuthorMarker> = state.field(lineAuthorsField);
  const out: Array<[number, number]> = [];
  for (let it = set.iter(); it.value; it.next()) out.push([state.doc.lineAt(it.from).number, it.value.author]);
  return out;
}

const start = () => EditorState.create({ doc: "a\nb\nc\nd\ne", extensions: [lineAuthorsField] });

it("puts a marker at the start of exactly the run lines", () => {
  const state = start().update({ effects: setLineAuthors.of({ attr, strings }) }).state;
  expect(marked(state)).toEqual([
    [2, 0],
    [3, 0],
    [5, 1],
  ]);
  const set = state.field(lineAuthorsField);
  for (let it = set.iter(); it.value; it.next()) expect(state.doc.lineAt(it.from).from).toBe(it.from);
});

it("markers follow an inserted line above them", () => {
  const state = start().update({ effects: setLineAuthors.of({ attr, strings }) }).state;
  const moved = state.update({ changes: { from: 0, insert: "new\n" } }).state;
  expect(marked(moved)).toEqual([
    [3, 0],
    [4, 0],
    [6, 1],
  ]);
});

it("null clears the markers", () => {
  const state = start().update({ effects: setLineAuthors.of({ attr, strings }) }).state;
  expect(marked(state.update({ effects: setLineAuthors.of(null) }).state)).toEqual([]);
});

it("markers are equal for the same author, spec and label", () => {
  const spec = { kind: "agent", profile: "claude", letter: undefined } as const;
  const a = new AuthorMarker(0, spec, "claude");
  expect(a.eq(new AuthorMarker(0, { ...spec }, "claude"))).toBe(true);
  expect(a.eq(new AuthorMarker(1, spec, "claude"))).toBe(false);
  expect(a.eq(new AuthorMarker(0, { kind: "agent", profile: "codex", letter: undefined }, "claude"))).toBe(false);
  expect(a.eq(new AuthorMarker(0, { kind: "outside" }, "claude"))).toBe(false);
  expect(new AuthorMarker(1, { kind: "outside" }, "You").eq(new AuthorMarker(1, { kind: "outside" }, "You"))).toBe(true);
});
