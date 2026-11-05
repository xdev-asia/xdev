import { type EditorState, type Extension, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, keymap, WidgetType } from "@codemirror/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewNote } from "@/api";
import { I18nContext, type I18n } from "@/i18n";
import { NoteCard, noteLabel } from "./NoteCard";
import { NoteComposer } from "./NoteComposer";

/** The lines a new note covers, 1-based on the new side, and what they say now. */
export type NoteRange = { startLine: number; line: number; anchor: string };

export type NoteHandlers = {
  add(range: NoteRange, body: string): void;
  edit(id: string, body: string): void;
  remove(id: string): void;
  /** Set while the worktree has an open PR; posts the note as an inline comment. */
  post?(note: ReviewNote): Promise<void>;
};

/** The selection's lines as a range; a selection that ends at the start of a line stops on the line before. */
export function rangeFromSelection(state: EditorState): NoteRange {
  const { from, to, empty } = state.selection.main;
  const first = state.doc.lineAt(from);
  let last = state.doc.lineAt(to);
  if (!empty && last.number > first.number && last.from === to) last = state.doc.line(last.number - 1);
  return rangeOfLines(state, first.number, last.number);
}

export function rangeOfLines(state: EditorState, startLine: number, line: number): NoteRange {
  const from = state.doc.line(startLine).from;
  const to = state.doc.line(line).to;
  return { startLine, line, anchor: state.doc.sliceString(from, to) };
}

/** `c` alone (a held modifier makes it another key to the editor) and Ctrl+Shift+A. */
export const NOTE_KEYS = ["c", "Ctrl-Shift-a"];

export const setNotes = StateEffect.define<ReviewNote[]>();
export const openComposer = StateEffect.define<NoteRange | null>();
const hoverLine = StateEffect.define<number | null>();

type Ctx = { file: string; handlers: () => NoteHandlers; i18n: () => I18n };

/** A block under a line that holds a React tree. */
class ReactWidget extends WidgetType {
  private root: Root | null = null;
  constructor(
    private readonly key: string,
    private readonly ctx: Ctx,
    private readonly make: (view: EditorView) => ReturnType<typeof createElement>,
  ) {
    super();
  }

  eq(other: ReactWidget): boolean {
    return other.key === this.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "rv-widget";
    this.root = createRoot(el);
    this.root.render(createElement(I18nContext.Provider, { value: this.ctx.i18n() }, this.make(view)));
    return el;
  }

  destroy(): void {
    const root = this.root;
    this.root = null;
    // Unmounting while CodeMirror is still updating would re-enter React's render.
    queueMicrotask(() => root?.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const tint = Decoration.line({ class: "rv-noted" });

type Field = { notes: ReviewNote[]; composer: NoteRange | null; deco: DecorationSet };

function build(state: EditorState, ctx: Ctx, notes: ReviewNote[], composer: NoteRange | null): DecorationSet {
  const out: Range<Decoration>[] = [];
  const lines = state.doc.lines;
  const widgetAt = (line: number, key: string, make: (view: EditorView) => ReturnType<typeof createElement>) =>
    out.push(Decoration.widget({ widget: new ReactWidget(key, ctx, make), block: true, side: 1 }).range(state.doc.line(line).to));
  for (const note of notes) {
    // A note past the end of the file waits in the Notes list until its file is read again.
    if (note.file !== ctx.file || note.line > lines || note.startLine < 1) continue;
    for (let n = note.startLine; n <= note.line; n++) out.push(tint.range(state.doc.line(n).from));
    // The key covers everything the card shows, so an edited note draws again.
    const post = ctx.handlers().post;
    const key = `${note.id}|${note.body}|${note.sentAt}|${note.outdated}|${note.startLine}-${note.line}|${post ? "pr" : ""}`;
    widgetAt(note.line, key, () =>
      createElement(NoteCard, { note, onEdit: (body: string) => ctx.handlers().edit(note.id, body), onDelete: () => ctx.handlers().remove(note.id), onPostToPr: post ? (n: ReviewNote) => ctx.handlers().post!(n) : undefined }),
    );
  }
  if (composer && composer.line <= lines) {
    const range = composer;
    widgetAt(range.line, `new|${range.startLine}-${range.line}`, (view) => {
      const close = () => {
        view.dispatch({ effects: openComposer.of(null) });
        view.focus();
      };
      return createElement(NoteComposer, {
        label: noteLabel({ file: ctx.file, startLine: range.startLine, line: range.line }),
        onSave: (body: string) => {
          ctx.handlers().add(range, body);
          close();
        },
        onCancel: close,
      });
    });
  }
  return Decoration.set(out, true);
}

class PlusMarker extends GutterMarker {
  toDOM(): Node {
    const el = document.createElement("span");
    el.className = "rv-plus";
    el.textContent = "+";
    return el;
  }
}
const plus = new PlusMarker();

/**
 * Notes on the new side of one file: a block card under each noted line, the composer, a `+` in the
 * gutter on the hovered line, and the keys `c` and Ctrl+Shift+A for the selection's lines. Feed it
 * notes with `setNotes`; close the composer with `openComposer(null)`.
 */
export function noteExtension(ctx: Ctx): Extension {
  const field = StateField.define<Field>({
    create: () => ({ notes: [], composer: null, deco: Decoration.none }),
    update(value, tr) {
      let { notes, composer } = value;
      let dirty = tr.docChanged;
      for (const e of tr.effects) {
        if (e.is(setNotes)) {
          notes = e.value;
          dirty = true;
        } else if (e.is(openComposer)) {
          composer = e.value;
          dirty = true;
        }
      }
      return dirty ? { notes, composer, deco: build(tr.state, ctx, notes, composer) } : value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  const hover = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(hoverLine)) return e.value;
      return value;
    },
  });

  const open = (view: EditorView, range: NoteRange): void => {
    // A second request keeps the draft: the composer for the same lines is already there.
    view.dispatch({ effects: openComposer.of(range) });
    queueMicrotask(() => view.dom.querySelector<HTMLTextAreaElement>(".rv-composer textarea")?.focus());
  };

  const hovered = (view: EditorView, event: MouseEvent): void => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const line = pos === null ? null : view.state.doc.lineAt(pos).number;
    if (line !== view.state.field(hover)) view.dispatch({ effects: hoverLine.of(line) });
  };

  return [
    field,
    hover,
    gutter({
      class: "rv-add-gutter",
      lineMarker: (view, line) => (view.state.field(hover) === view.state.doc.lineAt(line.from).number ? plus : null),
      lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(hoverLine))),
      initialSpacer: () => plus,
      domEventHandlers: {
        mousedown(view, line) {
          const n = view.state.doc.lineAt(line.from).number;
          open(view, rangeOfLines(view.state, n, n));
          return true;
        },
        mousemove(view, line) {
          const n = view.state.doc.lineAt(line.from).number;
          if (n !== view.state.field(hover)) view.dispatch({ effects: hoverLine.of(n) });
          return false;
        },
      },
    }),
    EditorView.domEventHandlers({
      mousemove: (event, view) => hovered(view, event),
      mouseleave: (_event, view) => {
        if (view.state.field(hover) !== null) view.dispatch({ effects: hoverLine.of(null) });
      },
    }),
    // A read-only editor takes no focus by itself; the keys need it.
    EditorView.contentAttributes.of({ tabindex: "0" }),
    keymap.of(
      NOTE_KEYS.map((key) => ({
        key,
        preventDefault: true,
        run: (view: EditorView) => {
          open(view, rangeFromSelection(view.state));
          return true;
        },
      })),
    ),
  ];
}
