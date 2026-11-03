import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";
import type { Chunk } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ReviewFile, type WorktreeFileDiff } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { ProblemNote } from "@/components/ChangesPanel";
import { diffTheme, DiffStats } from "@/components/DiffView";
import { highlight, theme } from "@/components/Editor";
import { useI18n } from "@/i18n";
import { ignoreWhitespaceDiff, onlyWhitespace, whitespaceSupported } from "./whitespace";
import type { ViewOptions } from "./viewOptions";

/** What the review view needs from a mounted diff: how many changes it has and a way to jump to one. */
export type DiffHandle = { chunks(): number; goTo(chunk: number): void };

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
  onStage(file: ReviewFile): void;
  register(path: string, handle: DiffHandle | null): void;
  onChunks(path: string, count: number): void;
};

type Built = { chunks(): readonly Chunk[]; goTo(chunk: number): void; destroy(): void };

function build(host: HTMLElement, diff: WorktreeFileDiff, opts: ViewOptions, label: string): Built {
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
  const jump = (view: EditorView, chunk: Chunk | undefined) => {
    if (!chunk) return;
    view.dispatch({ selection: { anchor: Math.min(chunk.fromB, view.state.doc.length) }, effects: EditorView.scrollIntoView(chunk.fromB, { y: "center" }) });
    view.dom.scrollIntoView?.({ block: "nearest" });
  };
  if (opts.layout === "split") {
    const merge = new MergeView({
      parent: host,
      a: { doc: oldText, extensions: common },
      b: { doc: newText, extensions: common },
      diffConfig,
      collapseUnchanged,
      highlightChanges: true,
      gutter: true,
    });
    return { chunks: () => merge.chunks, goTo: (i) => jump(merge.b, merge.chunks[i]), destroy: () => merge.destroy() };
  }
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: newText,
      extensions: [...common, unifiedMergeView({ original: oldText, mergeControls: false, syntaxHighlightDeletions: true, collapseUnchanged, diffConfig })],
    }),
  });
  return { chunks: () => getChunks(view.state)?.chunks ?? [], goTo: (i) => jump(view, getChunks(view.state)?.chunks[i]), destroy: () => view.destroy() };
}

/** One file of the review: its header, and the diff itself while the file is open. */
export function FileDiff(props: FileDiffProps): JSX.Element {
  const { api, worktree, base, file, opts, open, rev, register, onChunks } = props;
  const { t } = useI18n();
  const [diff, setDiff] = useState<WorktreeFileDiff | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);

  // Only an open file reads its two sides.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setProblem(null);
    api.worktreeReviewFile(worktree, base, file.path).then(
      (d) => alive && setDiff(d),
      (e) => alive && setProblem(toApiError(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, worktree, base, file.path, open, rev]);

  const shown = open && diff && !diff.skip ? diff : null;
  useEffect(() => {
    if (!shown || !host.current) return;
    const built = build(host.current, shown, opts, t("diff.label"));
    const count = () => built.chunks().length;
    register(file.path, { chunks: count, goTo: built.goTo });
    onChunks(file.path, count());
    return () => {
      register(file.path, null);
      built.destroy();
    };
  }, [shown, opts.layout, opts.ignoreWhitespace, opts.collapse, opts.lineNumbers, opts.wrap, t]);

  // A reveal scrolls the file's section to the top of the list.
  useEffect(() => {
    if (props.revealSeq > 0) root.current?.scrollIntoView?.({ block: "start" });
  }, [props.revealSeq]);

  const blank = shown !== null && opts.ignoreWhitespace && onlyWhitespace(shown.old ?? "", shown.new ?? "");
  const staged = file.staged && !file.unstaged;
  return (
    <section className="rv-file" data-path={file.path} ref={root}>
      <header className="rv-file-head">
        <button type="button" className="rv-file-toggle" aria-expanded={open} onClick={() => props.onToggle(file.path)}>
          <span className="rv-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="rv-letter ws-mono" data-kind={file.kind} aria-hidden="true">
            {LETTER[file.kind]}
          </span>
          <span className="rv-file-path ws-mono">{file.path}</span>
        </button>
        {shown && <DiffStats base={shown.old ?? ""} current={shown.new ?? ""} />}
        <button type="button" className="rv-stage" disabled={props.busy} onClick={() => props.onStage(file)}>
          {staged ? t("review.unstage") : t("review.stage")}
        </button>
      </header>
      {open && problem && <ProblemNote problem={problem} />}
      {open && diff?.skip === "binary" && <p className="ws-empty">{t("workspace.diff.binary")}</p>}
      {open && diff?.skip === "too_large" && <p className="ws-empty">{t("workspace.diff.tooLarge")}</p>}
      {blank && <p className="ws-empty">{t("review.whitespaceOnly")}</p>}
      {open && !problem && !diff && <p className="ws-empty">{t("review.loading")}</p>}
      {shown && <div className="rv-file-body editor diff" ref={host} />}
    </section>
  );
}
