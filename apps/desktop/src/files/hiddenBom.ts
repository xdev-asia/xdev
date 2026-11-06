import { Prec, RangeSet, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const BOM = "﻿";

/** The hidden range: the first character when it is a byte order mark, else nothing. */
export function bomSet(state: EditorState): DecorationSet {
  return state.doc.sliceString(0, 1) === BOM ? Decoration.set([Decoration.replace({}).range(0, 1)]) : Decoration.none;
}

const field = StateField.define<DecorationSet>({
  create: bomSet,
  update: (value, tr) => (tr.docChanged ? bomSet(tr.state) : value),
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f) as RangeSet<Decoration>)],
});

/**
 * Hides a leading byte order mark. It stays in the document, so a save writes it back, but it no
 * longer shows as a red special-character dot and the cursor steps over it.
 */
export function hiddenBom(): Extension {
  // Above basicSetup's special-character marks, which would otherwise draw over this one.
  return Prec.high(field);
}
