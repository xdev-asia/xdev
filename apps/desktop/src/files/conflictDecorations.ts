import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type ConflictBlock, type ConflictChoice, parseConflicts, resolveBlock } from "./conflictMarkers";

export interface ConflictLabels {
  /** The name of block `n` of `total` (1-based). */
  bar: (n: number, total: number) => string;
  current: string;
  incoming: string;
  both: string;
}

const CHOICES: readonly ConflictChoice[] = ["current", "incoming", "both"];

/** The edit that settles one block: the lines from the opening marker to the closing one become the chosen side. */
export function conflictChange(state: EditorState, block: ConflictBlock, choice: ConflictChoice): { from: number; to: number; insert: string } {
  const { doc } = state;
  const from = doc.line(block.start + 1).from;
  const last = doc.line(block.end + 1);
  const text = doc.sliceString(from, last.to);
  const shift = (n: number | undefined): number | undefined => (n === undefined ? n : n - block.start);
  const relative: ConflictBlock = { start: 0, ...(block.base !== undefined ? { base: shift(block.base) } : {}), mid: block.mid - block.start, end: block.end - block.start } as ConflictBlock;
  const insert = resolveBlock(text, relative, choice);
  // A side with no lines takes a line break with it, so no empty line is left behind.
  // At the end of the document it is the break before the block that goes.
  if (insert === "" && last.to < doc.length) return { from, to: last.to + 1, insert };
  if (insert === "" && from > 0) return { from: from - 1, to: last.to, insert };
  return { from, to: last.to, insert };
}

class ConflictBar extends WidgetType {
  /** The accessible name of the bar: which block of how many. */
  readonly label: string;

  constructor(
    private readonly block: ConflictBlock,
    private readonly labels: ConflictLabels,
    n: number,
    total: number,
  ) {
    super();
    this.label = labels.bar(n, total);
  }

  eq(other: ConflictBar): boolean {
    const a = this.block;
    const b = other.block;
    return a.start === b.start && a.base === b.base && a.mid === b.mid && a.end === b.end && this.label === other.label && CHOICES.every((c) => this.labels[c] === other.labels[c]);
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", this.label);
    for (const choice of CHOICES) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.accept = choice;
      button.textContent = this.labels[choice];
      // Keeps the caret where it is.
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => view.dispatch({ changes: conflictChange(view.state, this.block, choice) }));
      bar.append(button);
    }
    return bar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const ours = Decoration.line({ class: "cm-conflict-ours" });
const theirs = Decoration.line({ class: "cm-conflict-theirs" });
const marker = Decoration.line({ class: "cm-conflict-marker" });

function build(state: EditorState, labels: () => ConflictLabels): DecorationSet {
  const text = state.doc.toString();
  // Most files have no conflict: the common case costs one scan.
  if (!text.includes("<<<<<<<")) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const lineFrom = (n: number): number => state.doc.line(n + 1).from;
  const mark = (n: number, deco: Decoration): void => void ranges.push(deco.range(lineFrom(n)));
  const blocks = parseConflicts(text);
  blocks.forEach((b, i) => {
    ranges.push(Decoration.widget({ widget: new ConflictBar(b, labels(), i + 1, blocks.length), block: true, side: -1 }).range(lineFrom(b.start)));
    mark(b.start, marker);
    for (let n = b.start + 1; n < (b.base ?? b.mid); n++) mark(n, ours);
    if (b.base !== undefined) for (let n = b.base; n < b.mid; n++) mark(n, marker);
    mark(b.mid, marker);
    for (let n = b.mid + 1; n < b.end; n++) mark(n, theirs);
    mark(b.end, marker);
  });
  return Decoration.set(ranges, true);
}

/**
 * Tints the sides of every conflict block of the text and puts the accept actions above it. The accept
 * actions edit the buffer; nothing is written until the file is saved. Parsed when the text changes only.
 */
export function conflictDecorations(labels: () => ConflictLabels): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, labels),
    update: (deco, tr) => (tr.docChanged ? build(tr.state, labels) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
  return field;
}
