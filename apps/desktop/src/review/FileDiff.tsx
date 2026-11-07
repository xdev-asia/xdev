import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";
import type { Chunk } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { toApiError, type Api, type LineAttribution, type ReviewFile, type ReviewNote, type WorktreeFileDiff } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { ProblemNote } from "@/components/ChangesPanel";
import { diffTheme, DiffStats } from "@/components/DiffView";
import { highlight, theme } from "@/components/Editor";
import { useI18n, type I18n } from "@/i18n";
import { attributionGutter, setLineAuthors } from "./attribution/lineGutter";
import { applicable } from "./attribution/lineGutterModel";
import { LineLegend } from "./attribution/LineLegend";
import { ImageDiff } from "./ImageDiff";
import { isImagePath } from "./imageDiffModel";
import { noteExtension, setNotes, type NoteHandlers } from "./noteWidgets";
import { ignoreWhitespaceDiff, onlyWhitespace, whitespaceSupported } from "./whitespace";
import type { ViewOptions } from "./viewOptions";

/** What the review view needs from a mounted diff: how many changes it has and a way to jump to one. */
export type DiffHandle = { chunks(): number; goTo(chunk: number): void; goToLine(line: number): void };

// Git's own letters, so they read the same in every language.
const LETTER: Record<ReviewFile["kind"], string> = { added: "A", modified: "M", deleted: "D" };

export type FileDiffProps = {
  api: Api;
  worktree: string;
  /** The commit id the old side is read at. */
  base: string;
  file: ReviewFile;
  opts: ViewOptions;
  open: boolean;
  /** Changes with each reload, so an open file reads again. */
  rev: number;
  /** A new value scrolls this file into view. */
  revealSeq: number;
  busy: boolean;
  onToggle(path: string): void;
  /** `stage` true stages the file's unstaged changes; false unstages its staged ones. */
  onStage(file: ReviewFile, stage: boolean): void;
  register(path: string, handle: DiffHandle | null): void;
  onChunks(path: string, count: number): void;
  /** This file's notes, drawn under their lines on the new side. */
  notes: ReviewNote[];
  handlers: NoteHandlers;
  /** Told each time the file's new text is read (`null` when the file is gone), to re-anchor its notes. */
  onRead(path: string, text: string | null): void;
  /** Who changed the file and its versions, drawn in the header after the path. */
  extra?: ReactNode;
};

type Strings = I18n["t"];
type Built = {
  chunks(): readonly Chunk[];
  goTo(chunk: number): void;
  goToLine(line: number): void;
  destroy(): void;
  notes(list: ReviewNote[]): void;
  /** Puts the line authors on the new side; `null` clears them. A no-op when the gutter is off. */
  authors(attr: LineAttribution | null, strings: Strings): void;
};

/** The runs fit what the diff shows; otherwise nothing until the next read. */
export { applicable };

function build(host: HTMLElement, diff: WorktreeFileDiff, opts: ViewOptions, label: string, notes: Extension): Built {
  // The authors gutter goes first, so it is the leftmost on the new side.
  const authorsGutter: Extension[] = opts.attribution ? [attributionGutter()] : [];
  const authorsOf = (view: EditorView, attr: LineAttribution | null, strings: Strings) => {
    if (opts.attribution) view.dispatch({ effects: setLineAuthors.of(attr && { attr, strings }) });
  };
  const oldText = diff.old ?? "";
  const newText = diff.new ?? "";
  const quiet = opts.ignoreWhitespace && whitespaceSupported(oldText, newText);
  const diffConfig = quiet ? { override: ignoreWhitespaceDiff } : undefined;
  const collapseUnchanged = opts.collapse ? { margin: 3, minSize: 6 } : undefined;
  const common: Extension[] = [
    ...(opts.lineNumbers ? [lineNumbers()] : []),
    markdown(),
    syntaxHighlighting(highlight),
    ...(opts.wrap ? [EditorView.lineWrapping] : []),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ "aria-label": label }),
    theme,
    diffTheme,
  ];
  const jumpTo = (view: EditorView, pos: number) => {
    const at = Math.min(pos, view.state.doc.length);
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.dom.scrollIntoView?.({ block: "nearest" });
  };
  const jump = (view: EditorView, chunk: Chunk | undefined) => chunk && jumpTo(view, chunk.fromB);
  const jumpLine = (view: EditorView, line: number) => jumpTo(view, view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines)).from);
  if (opts.layout === "split") {
    const merge = new MergeView({
      parent: host,
      a: { doc: oldText, extensions: common },
      b: { doc: newText, extensions: [...authorsGutter, ...common, notes] },
      diffConfig,
      collapseUnchanged,
      highlightChanges: true,
      gutter: true,
    });
    return {
      chunks: () => merge.chunks,
      goTo: (i) => jump(merge.b, merge.chunks[i]),
      goToLine: (n) => jumpLine(merge.b, n),
      destroy: () => merge.destroy(),
      notes: (list) => merge.b.dispatch({ effects: setNotes.of(list) }),
      authors: (attr, strings) => authorsOf(merge.b, attr, strings),
    };
  }
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: newText,
      extensions: [...authorsGutter, ...common, notes, unifiedMergeView({ original: oldText, mergeControls: false, syntaxHighlightDeletions: true, collapseUnchanged, diffConfig })],
    }),
  });
  return {
    chunks: () => getChunks(view.state)?.chunks ?? [],
    goTo: (i) => jump(view, getChunks(view.state)?.chunks[i]),
    goToLine: (n) => jumpLine(view, n),
    destroy: () => view.destroy(),
    notes: (list) => view.dispatch({ effects: setNotes.of(list) }),
    authors: (attr, strings) => authorsOf(view, attr, strings),
  };
}

/** The old diff when a reload read the same content, so the editors are not built again for nothing. */
export function keepSame(prev: WorktreeFileDiff | null, next: WorktreeFileDiff): WorktreeFileDiff {
  return prev && prev.old === next.old && prev.new === next.new && prev.skip === next.skip ? prev : next;
}

/** One file of the review: its header, and the diff itself while the file is open. */
export function FileDiff(props: FileDiffProps): JSX.Element {
  const { api, worktree, base, file, opts, open, rev, register, onChunks } = props;
  const i18n: I18n = useI18n();
  const { t } = i18n;
  const [diff, setDiff] = useState<WorktreeFileDiff | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [lineAttr, setLineAttr] = useState<LineAttribution | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const built = useRef<Built | null>(null);
  // The widgets outlive a render, so they read the latest handlers and strings through these.
  const live = useRef({ handlers: props.handlers, i18n });
  live.current = { handlers: props.handlers, i18n };

  // A changed image is drawn as images, not read as text.
  const image = isImagePath(file.path);
  // Only an open file reads its two sides.
  useEffect(() => {
    if (!open || image) return;
    let alive = true;
    setProblem(null);
    api.worktreeReviewFile(worktree, base, file.path).then(
      (d) => {
        if (!alive) return;
        setDiff((prev) => keepSame(prev, d));
        if (!d.skip) props.onRead(file.path, d.new);
      },
      (e) => alive && setProblem(toApiError(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, worktree, base, file.path, open, rev, image]);

  const shown = open && diff && !diff.skip ? diff : null;
  // Who wrote each changed line; read apart from the diff, so it is kept only when it fits the shown text.
  useEffect(() => {
    setLineAttr(null);
    if (!shown || !opts.attribution || image) return;
    let alive = true;
    api.attributionLines(worktree, file.path, base).then(
      (a) => alive && setLineAttr(applicable(a, shown.new ?? "") ? a : null),
      () => alive && setLineAttr(null),
    );
    return () => {
      alive = false;
    };
  }, [api, worktree, base, file.path, shown, opts.attribution, rev, image]);

  useEffect(() => {
    if (!shown || !host.current) return;
    const ext = noteExtension({ file: file.path, handlers: () => live.current.handlers, i18n: () => live.current.i18n });
    const made = build(host.current, shown, opts, t("diff.label"), ext);
    made.notes(props.notes);
    built.current = made;
    const count = () => made.chunks().length;
    register(file.path, { chunks: count, goTo: made.goTo, goToLine: made.goToLine });
    onChunks(file.path, count());
    return () => {
      register(file.path, null);
      built.current = null;
      made.destroy();
    };
  }, [shown, opts.layout, opts.ignoreWhitespace, opts.collapse, opts.lineNumbers, opts.wrap, opts.attribution, t]);

  useEffect(() => {
    built.current?.notes(props.notes);
  }, [props.notes, shown, opts.layout, opts.ignoreWhitespace, opts.collapse, opts.lineNumbers, opts.wrap, opts.attribution, t]);

  useEffect(() => {
    built.current?.authors(lineAttr, live.current.i18n.t);
  }, [lineAttr, shown, opts.layout, opts.ignoreWhitespace, opts.collapse, opts.lineNumbers, opts.wrap, opts.attribution, t]);

  // A reveal scrolls the file's section to the top of the list.
  useEffect(() => {
    if (props.revealSeq > 0) root.current?.scrollIntoView?.({ block: "start" });
  }, [props.revealSeq]);

  const blank = shown !== null && opts.ignoreWhitespace && onlyWhitespace(shown.old ?? "", shown.new ?? "");
  return (
    <section className="rv-file" data-path={file.path} ref={root}>
      <header className="rv-file-head">
        <Button type="button" variant="ghost" className="rv-file-toggle" aria-expanded={open} onClick={() => props.onToggle(file.path)}>
          <span className="rv-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="rv-letter ws-mono" data-kind={file.kind} aria-hidden="true">
            {LETTER[file.kind]}
          </span>
          <span className="rv-file-path ws-mono">{file.path}</span>
        </Button>
        {props.extra}
        {shown && <DiffStats base={shown.old ?? ""} current={shown.new ?? ""} />}
        {file.unstaged && (
          <Button type="button" size="sm" disabled={props.busy} onClick={() => props.onStage(file, true)}>
            {t("review.stage")}
          </Button>
        )}
        {file.staged && (
          <Button type="button" size="sm" disabled={props.busy} onClick={() => props.onStage(file, false)}>
            {t("review.unstage")}
          </Button>
        )}
      </header>
      {open && problem && <ProblemNote problem={problem} />}
      {open && image && <ImageDiff api={api} worktree={worktree} path={file.path} kind={file.kind} base={base} rev={rev} />}
      {open && !image && diff?.skip === "binary" && <p className="ws-empty">{t("workspace.diff.binary")}</p>}
      {open && !image && diff?.skip === "too_large" && <p className="ws-empty">{t("workspace.diff.tooLarge")}</p>}
      {blank && <p className="ws-empty">{t("review.whitespaceOnly")}</p>}
      {open && !image && !problem && !diff && <p className="ws-empty">{t("review.loading")}</p>}
      {shown && opts.attribution && <LineLegend attr={lineAttr} />}
      {shown && <div className="rv-file-body editor diff" ref={host} />}
    </section>
  );
}
