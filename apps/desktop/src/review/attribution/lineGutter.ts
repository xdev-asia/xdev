import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import type { LineAttribution } from "@/api";
import { CHIP_CLASS, chipLetter, markerSpec, OUTSIDE_CLASS, tooltipOf, type MarkerSpec } from "./lineGutterModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Sets the line authors of the doc; `null` clears them. `attr` must fit the doc (see `applicable`). */
export const setLineAuthors = StateEffect.define<{ attr: LineAttribution; strings: T } | null>();

/** One gutter cell: the agent's chip, or the "You" ring. */
export class AuthorMarker extends GutterMarker {
  constructor(
    readonly author: number,
    readonly spec: MarkerSpec,
    readonly label: string,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof AuthorMarker &&
      other.author === this.author &&
      other.label === this.label &&
      other.spec.kind === this.spec.kind &&
      (other.spec.kind === "outside" || (this.spec.kind === "agent" && other.spec.profile === this.spec.profile && other.spec.letter === this.spec.letter))
    );
  }

  toDOM(view: EditorView): Node {
    const el = view.dom.ownerDocument.createElement("span");
    el.setAttribute("role", "img");
    el.title = this.label;
    el.setAttribute("aria-label", this.label);
    if (this.spec.kind === "outside") {
      el.className = OUTSIDE_CLASS;
      return el;
    }
    el.className = CHIP_CLASS;
    // As `AgentChip`: a custom agent has no profile attribute.
    if (this.spec.profile !== "custom") el.dataset.profile = this.spec.profile;
    el.textContent = chipLetter(this.spec);
    return el;
  }
}

function markersOf(state: EditorState, attr: LineAttribution, t: T): RangeSet<AuthorMarker> {
  const made = attr.authors.map((a, i) => new AuthorMarker(i, markerSpec(a), tooltipOf(attr, i, t)));
  const ranges: Range<AuthorMarker>[] = [];
  const last = state.doc.lines;
  for (const r of attr.runs) {
    const marker = made[r.author];
    if (!marker) continue;
    for (let n = Math.max(1, r.from); n <= Math.min(r.to, last); n++) ranges.push(marker.range(state.doc.line(n).from));
  }
  return RangeSet.of(ranges, true);
}

/** The markers of the doc; they follow edits, so an editable doc keeps them on their lines. */
export const lineAuthorsField = StateField.define<RangeSet<AuthorMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLineAuthors)) next = e.value ? markersOf(tr.state, e.value.attr, e.value.strings) : RangeSet.empty;
    return next;
  },
});

/** The line-authors gutter: one narrow cell per line, placed where it is added (first, for leftmost). */
export function attributionGutter(): Extension {
  return [lineAuthorsField, gutter({ class: "attr-gutter", markers: (view) => view.state.field(lineAuthorsField) })];
}
