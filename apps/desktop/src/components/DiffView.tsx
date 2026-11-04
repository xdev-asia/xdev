import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Chunk, unifiedMergeView } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { useEditorTheme } from "@/ui/editorTheme";
import { highlight, theme } from "./Editor";

const added = "color-mix(in srgb, var(--x-color-ok) 30%, transparent)";
const removed = "color-mix(in srgb, var(--x-color-danger) 30%, transparent)";
const addedLine = "color-mix(in srgb, var(--x-color-ok) 14%, transparent)";

// The merge package ships fixed light/dark colors; `&.cm-merge-b` matches the specificity of its rules,
// and theme rules are mounted after base themes, so these win in both color schemes.
export const diffTheme = EditorView.theme({
  "&": { backgroundColor: "var(--x-color-surface)" },
  ".cm-scroller": { fontFamily: "var(--x-font-mono)", fontSize: "12.5px", lineHeight: "1.7" },
  ".cm-content": { padding: "var(--x-space-2) 0" },
  ".cm-line": { padding: "0 var(--x-space-4) 0 var(--x-space-3)" },
  ".cm-gutters": { backgroundColor: "var(--x-color-surface)" },
  "&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine": { backgroundColor: addedLine },
  "&.cm-merge-b .cm-changedText": { background: `linear-gradient(${added}, ${added})` },
  "&.cm-merge-b .cm-deletedChunk": { backgroundColor: "var(--x-color-danger-soft)", paddingLeft: "0" },
  "&.cm-merge-b .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedChunk .cm-changedText": {
    background: `linear-gradient(${removed}, ${removed})`,
  },
  "&.cm-merge-b .cm-deletedLine": { padding: "0 var(--x-space-4) 0 var(--x-space-3)", color: "var(--x-color-muted)" },
  "&.cm-merge-b .cm-changedLineGutter, &.cm-merge-b .cm-inlineChangedLineGutter": { background: "var(--x-color-ok)" },
  "&.cm-merge-b .cm-deletedLineGutter": { background: "var(--x-color-danger)" },
  "&.cm-merge-b .cm-collapsedLines": {
    background: "var(--x-color-surface-2)",
    color: "var(--x-color-muted)",
    fontFamily: "var(--x-font-body)",
    padding: "var(--x-space-1) var(--x-space-4)",
  },
});

// Lines added and removed, counted from the same chunks the merge view draws.
export function diffStats(base: string, current: string): { added: number; removed: number } {
  const a = Text.of(base.split("\n"));
  const b = Text.of(current.split("\n"));
  const lines = (doc: Text, from: number, to: number, end: number) =>
    to > from ? doc.lineAt(Math.min(end, Math.max(from, to - 1))).number - doc.lineAt(from).number + 1 : 0;
  let added = 0;
  let removed = 0;
  for (const chunk of Chunk.build(a, b)) {
    removed += lines(a, chunk.fromA, chunk.toA, chunk.endA);
    added += lines(b, chunk.fromB, chunk.toB, chunk.endB);
  }
  return { added, removed };
}

export function DiffStats(props: { base: string; current: string }): JSX.Element {
  const { t } = useI18n();
  const { added, removed } = useMemo(() => diffStats(props.base, props.current), [props.base, props.current]);
  return (
    <span className="diff-stats">
      <span className="diff-added" aria-hidden="true">+{added}</span>
      <span className="diff-removed" aria-hidden="true">−{removed}</span>
      <span className="diff-stats-text">{t("diff.stats", { count: added, removed })}</span>
    </span>
  );
}

// Read-only: the spec leaves editing in the diff out, so approve/reject stay whole-file decisions.
export function DiffView(props: { base: string; current: string }): JSX.Element {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.current,
        extensions: [
          lineNumbers(),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": t("diff.label") }),
          theme,
          diffTheme,
          unifiedMergeView({
            original: props.base,
            mergeControls: false,
            syntaxHighlightDeletions: true,
            collapseUnchanged: { margin: 3, minSize: 6 },
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [props.base, props.current, t]);

  return <div className="editor diff" ref={host} data-theme={useEditorTheme()} />;
}
