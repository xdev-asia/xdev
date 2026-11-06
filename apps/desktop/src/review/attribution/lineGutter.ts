import { ChangeSet, EditorState, RangeSet, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import type { LineAttribution } from "@/api";
import { minimalChange } from "@/files/textDiff";
import { CHIP_CLASS, chipLetter, markerSpec, OUTSIDE_CLASS, tooltipOf, type MarkerSpec } from "./lineGutterModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Sets the line authors of the doc; `null` clears them. `attr` must fit `text` when given, else the
 * doc (see `applicable`). With a `text` that differs from the doc (an edited, unsaved buffer), the
 * markers are placed on `text` and moved through the one change to the doc; lines that change
 * touches lose theirs.
 */
export const setLineAuthors = StateEffect.define<{ attr: LineAttribution; strings: T; text?: string } | null>();

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

/**
 * The markers of `attr`, whose runs are lines of `source`, placed on `doc`. `place` turns a line
 * start of `source` into a position of `doc`.
 */
function markersOf(doc: Text, attr: LineAttribution, t: T, source: Text = doc, place: (pos: number) => number = (pos) => pos): RangeSet<AuthorMarker> {
  const made = attr.authors.map((a, i) => new AuthorMarker(i, markerSpec(a), tooltipOf(attr, i, t)));
  const ranges: Range<AuthorMarker>[] = [];
  const taken = new Set<number>();
  const last = source.lines;
  for (const r of attr.runs) {
    const marker = made[r.author];
    if (!marker) continue;
    for (let n = Math.max(1, r.from); n <= Math.min(r.to, last); n++) {
      const was = source.line(n);
      const line = doc.lineAt(place(was.from));
      // A line the change rewrote is no longer the author's; a deleted line can land on another.
      if (source !== doc && (line.text !== was.text || taken.has(line.from))) continue;
      taken.add(line.from);
      ranges.push(marker.range(line.from));
    }
  }
  return RangeSet.of(ranges, true);
}

/** The markers of `attr`, made for `text` (the doc when absent), carried onto `doc`. */
function markersFor(doc: Text, attr: LineAttribution, t: T, text: string | undefined): RangeSet<AuthorMarker> {
  if (text === undefined) return markersOf(doc, attr, t);
  // Line breaks as the editor reads them.
  const source = EditorState.create({ doc: text }).doc;
  const change = minimalChange(source.toString(), doc.toString());
  if (!change) return markersOf(doc, attr, t);
  // Each line start is mapped on its own, after an insert at the same place, so a line typed
  // above keeps its author below it. Mapping the marker set would keep a line-start marker on a
  // line whose rest was rewritten (`GutterMarker` maps with `TrackBefore`), hence the text check.
  const changes = ChangeSet.of([change], source.length);
  return markersOf(doc, attr, t, source, (pos) => changes.mapPos(pos, 1));
}

/** The markers of the doc; they follow edits, so an editable doc keeps them on their lines. */
export const lineAuthorsField = StateField.define<RangeSet<AuthorMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLineAuthors)) next = e.value ? markersFor(tr.state.doc, e.value.attr, e.value.strings, e.value.text) : RangeSet.empty;
    return next;
  },
});

/** The gutter alone; `lineAuthorsField` must be in the editor too. Placed where it is added (first, for leftmost). */
export function lineAuthorsGutter(): Extension {
  return gutter({ class: "attr-gutter", markers: (view) => view.state.field(lineAuthorsField) });
}

/** The line-authors gutter: one narrow cell per line, placed where it is added (first, for leftmost). */
export function attributionGutter(): Extension {
  return [lineAuthorsField, lineAuthorsGutter()];
}
