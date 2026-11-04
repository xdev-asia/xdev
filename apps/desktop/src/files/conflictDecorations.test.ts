import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { conflictChange, conflictDecorations } from "./conflictDecorations";
import { parseConflicts } from "./conflictMarkers";

const labels = { bar: "Conflict", current: "Accept current", incoming: "Accept incoming", both: "Accept both" };
const doc = ["a", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "z"].join("\n");

function decorations(text: string): { line: number; class: string | null; widget: boolean }[] {
  const state = EditorState.create({ doc: text, extensions: [conflictDecorations(() => labels)] });
  const out: { line: number; class: string | null; widget: boolean }[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(null as unknown as EditorView) : source;
    for (const it = set.iter(); it.value; it.next()) {
      out.push({ line: state.doc.lineAt(it.from).number, class: (it.value.spec.class as string | undefined) ?? null, widget: Boolean(it.value.spec.widget) });
    }
  }
  return out;
}

it("tints each side and the markers, and puts one bar above the block", () => {
  const found = decorations(doc);
  expect(found.filter((d) => d.class === "cm-conflict-ours").map((d) => d.line)).toEqual([3]);
  expect(found.filter((d) => d.class === "cm-conflict-theirs").map((d) => d.line)).toEqual([5]);
  expect(found.filter((d) => d.class === "cm-conflict-marker").map((d) => d.line)).toEqual([2, 4, 6]);
  expect(found.filter((d) => d.widget).map((d) => d.line)).toEqual([2]);
});

it("draws nothing for a text with no conflict", () => {
  expect(decorations("a\nb\n")).toEqual([]);
});

function accept(choice: "current" | "incoming" | "both", text = doc): string {
  const state = EditorState.create({ doc: text });
  const [block] = parseConflicts(text);
  return state.update({ changes: conflictChange(state, block, choice) }).state.doc.toString();
}

it("accepting a side edits the buffer and leaves the rest", () => {
  expect(accept("current")).toBe("a\nours\nz");
  expect(accept("incoming")).toBe("a\ntheirs\nz");
  expect(accept("both")).toBe("a\nours\ntheirs\nz");
});

it("an empty side leaves no empty line behind", () => {
  const empty = ["a", "<<<<<<< HEAD", "=======", "theirs", ">>>>>>> f", "z"].join("\n");
  expect(accept("current", empty)).toBe("a\nz");
});

it("resolving the last block of the file works without a trailing line break", () => {
  const tail = ["<<<<<<< a", "x", "=======", "y", ">>>>>>> b"].join("\n");
  expect(accept("incoming", tail)).toBe("y");
});
