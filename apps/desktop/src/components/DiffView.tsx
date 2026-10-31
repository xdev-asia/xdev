import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "../i18n";
import { highlight, theme } from "./Editor";

const added = "color-mix(in srgb, var(--x-color-ok) 30%, transparent)";
const removed = "color-mix(in srgb, var(--x-color-warn) 30%, transparent)";

// The merge package ships fixed light/dark colors; `&.cm-merge-b` matches the specificity of its rules,
// and theme rules are mounted after base themes, so these win in both color schemes.
const diffTheme = EditorView.theme({
  "&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine": { backgroundColor: "var(--x-color-ok-soft)" },
  "&.cm-merge-b .cm-changedText": { background: `linear-gradient(${added}, ${added})` },
  "&.cm-merge-b .cm-deletedChunk": { backgroundColor: "var(--x-color-warn-soft)", paddingLeft: "0" },
  "&.cm-merge-b .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedChunk .cm-changedText": {
    background: `linear-gradient(${removed}, ${removed})`,
  },
  "&.cm-merge-b .cm-deletedLine": { padding: "0 var(--x-space-6)", color: "var(--x-color-muted)" },
  "&.cm-merge-b .cm-changedLineGutter, &.cm-merge-b .cm-inlineChangedLineGutter": { background: "var(--x-color-ok)" },
  "&.cm-merge-b .cm-deletedLineGutter": { background: "var(--x-color-warn)" },
  "&.cm-merge-b .cm-collapsedLines": {
    background: "var(--x-color-surface-2)",
    color: "var(--x-color-muted)",
    padding: "var(--x-space-1) var(--x-space-6)",
  },
});

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

  return <div className="editor diff" ref={host} />;
}
