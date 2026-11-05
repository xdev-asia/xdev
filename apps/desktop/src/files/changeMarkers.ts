import { type Extension, RangeSetBuilder, StateEffect, StateField, Text, type EditorState } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";

export type ChangeKind = "added" | "modified" | "deleted";
/** Lines are 1-based. A deletion is one marker on the line after the removed text. */
export type ChangeChunk = { kind: ChangeKind; fromLine: number; toLine: number };

/** Above this many lines on either side the diff is skipped: no markers, no navigation. */
export const CHANGE_LINE_CAP = 20_000;

const toText = (s: string) => Text.of(s.replace(/\r\n?/g, "\n").split("\n"));

const overCap = (base: Text, doc: Text) => base.lines > CHANGE_LINE_CAP || doc.lines > CHANGE_LINE_CAP;

function buildChunks(base: Text, doc: Text): { raw: readonly Chunk[]; chunks: ChangeChunk[] } {
  if (overCap(base, doc)) return { raw: [], chunks: [] };
  const raw = Chunk.build(base, doc);
  return { raw, chunks: raw.map((c) => describe(c, doc)) };
}

function describe(c: Chunk, doc: Text): ChangeChunk {
  if (c.fromB === c.toB) {
    const line = doc.lineAt(Math.min(c.fromB, doc.length)).number;
    return { kind: "deleted", fromLine: line, toLine: line };
  }
  return {
    kind: c.fromA === c.toA ? "added" : "modified",
    fromLine: doc.lineAt(c.fromB).number,
    toLine: doc.lineAt(c.endB).number,
  };
}

/** The changes of `doc` against `base`, in line terms. Line endings are not compared. */
export function changeChunks(base: string, doc: string): ChangeChunk[] {
  return buildChunks(toText(base), toText(doc)).chunks;
}

/**
 * The line to go to from `line`: the first line of the next change (`dir` 1) or the previous one
 * (`dir` -1), wrapping around. From inside a change, "previous" leaves that change.
 */
export function nextChangeLine(chunks: readonly ChangeChunk[], line: number, dir: 1 | -1): number | null {
  if (chunks.length === 0) return null;
  if (dir === 1) return (chunks.find((c) => c.fromLine > line) ?? chunks[0]).fromLine;
  for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i].toLine < line) return chunks[i].fromLine;
  return chunks[chunks.length - 1].fromLine;
}

/** Sets the text the gutter compares with; null clears the markers. */
export const setChangeBase = StateEffect.define<string | null>();

class Bar extends GutterMarker {
  constructor(readonly kind: ChangeKind) {
    super();
  }
  eq(other: Bar) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change-bar cm-change-${this.kind}`;
    return el;
  }
}
const BARS: Record<ChangeKind, Bar> = { added: new Bar("added"), modified: new Bar("modified"), deleted: new Bar("deleted") };

type Changes = {
  base: Text | null;
  /** Skipped for size: `raw` is empty without meaning "no changes". */
  capped: boolean;
  raw: readonly Chunk[];
  chunks: ChangeChunk[];
  markers: ReturnType<typeof markersOf>;
};

function markersOf(chunks: readonly ChangeChunk[], doc: Text) {
  const byLine = new Map<number, ChangeKind>();
  for (const c of chunks) for (let l = c.fromLine; l <= c.toLine; l++) if (!byLine.has(l)) byLine.set(l, c.kind);
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const l of [...byLine.keys()].sort((a, b) => a - b)) builder.add(doc.line(l).from, doc.line(l).from, BARS[byLine.get(l)!]);
  return builder.finish();
}

function compute(base: Text | null, doc: Text): Changes {
  if (!base) return { base, capped: false, raw: [], chunks: [], markers: markersOf([], doc) };
  const { raw, chunks } = buildChunks(base, doc);
  return { base, capped: overCap(base, doc), raw, chunks, markers: markersOf(chunks, doc) };
}

const changes = StateField.define<Changes>({
  create: (state) => compute(null, state.doc),
  update(value, tr) {
    let next: string | null | undefined;
    for (const e of tr.effects) if (e.is(setChangeBase)) next = e.value;
    if (next !== undefined) return compute(next === null ? null : toText(next), tr.newDoc);
    if (!tr.docChanged || !value.base) return value;
    const { base } = value;
    // Old chunks are reused only when they were built, not skipped for size.
    if (value.capped || overCap(base, tr.newDoc)) return compute(base, tr.newDoc);
    const raw = Chunk.updateB(value.raw, base, tr.newDoc, tr.changes);
    const chunks = raw.map((c) => describe(c, tr.newDoc));
    return { base, capped: false, raw, chunks, markers: markersOf(chunks, tr.newDoc) };
  },
});

/** The changes against the base set with `setChangeBase`. */
export function changeChunksOf(state: EditorState): ChangeChunk[] {
  return state.field(changes, false)?.chunks ?? [];
}

export function changeCount(state: EditorState): number {
  return changeChunksOf(state).length;
}

// Tokens only: the marker is a 2px bar inside the gutter, a 2px tick for a deletion.
const theme = EditorView.baseTheme({
  ".cm-change-gutter": { width: "var(--x-space-1)", marginRight: "var(--x-space-1)" },
  ".cm-change-gutter .cm-gutterElement": { padding: "0" },
  ".cm-change-bar": { width: "2px", height: "100%", margin: "0 auto" },
  ".cm-change-added": { backgroundColor: "var(--x-color-ok)" },
  ".cm-change-modified": { backgroundColor: "var(--x-color-signal)" },
  ".cm-change-deleted": { height: "2px", backgroundColor: "var(--x-color-danger)" },
});

/** The change gutter and its state. Needs `setChangeBase` to show anything. */
export function changeGutter(): Extension {
  return [
    changes,
    gutter({ class: "cm-change-gutter", markers: (view) => view.state.field(changes).markers, initialSpacer: () => BARS.added }),
    theme,
  ];
}
