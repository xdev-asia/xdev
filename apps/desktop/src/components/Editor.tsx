import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

// Only CSS variables, so the editor follows the app's light/dark tokens with no separate dark theme.
export const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--x-color-ink)",
    backgroundColor: "var(--x-color-surface)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--x-font-mono)", fontSize: "13px", lineHeight: "1.75" },
  ".cm-content": { padding: "var(--x-space-4) 0", caretColor: "var(--x-color-signal)" },
  ".cm-line": { padding: "0 var(--x-space-4)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--x-color-signal)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--x-color-accent-soft)" },
  ".cm-activeLine": { backgroundColor: "var(--x-color-surface-2)" },
  ".cm-gutters": {
    backgroundColor: "var(--x-color-surface)",
    color: "var(--x-color-muted)",
    border: "none",
    fontFamily: "var(--x-font-mono)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--x-color-surface-2)", color: "var(--x-color-ink)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--x-space-2) 0 var(--x-space-3)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--x-color-surface-2)",
    color: "var(--x-color-muted)",
    border: "1px solid var(--x-color-line)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--x-color-warn-soft)" },
  ".cm-searchMatch.cm-searchMatch-selected, .cm-selectionMatch, .cm-matchingBracket": {
    backgroundColor: "var(--x-color-accent-soft)",
  },
  ".cm-panels": { backgroundColor: "var(--x-color-surface-2)", color: "var(--x-color-ink)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--x-color-line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--x-color-line)" },
  ".cm-textfield": {
    backgroundColor: "var(--x-color-surface)",
    color: "var(--x-color-ink)",
    border: "1px solid var(--x-color-line)",
    borderRadius: "var(--x-radius-sm)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--x-color-surface)",
    color: "var(--x-color-ink)",
    border: "1px solid var(--x-color-line)",
    borderRadius: "var(--x-radius-sm)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--x-color-surface)",
    color: "var(--x-color-ink)",
    border: "1px solid var(--x-color-line)",
    borderRadius: "var(--x-radius-sm)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--x-color-accent-soft)",
    color: "var(--x-color-ink)",
  },
});

// Replaces CodeMirror's fallback highlighter, whose fixed colors are unreadable on the dark tokens.
export const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--x-color-ink)" },
  { tag: tags.heading1, fontSize: "1.15em" },
  { tag: tags.heading2, fontSize: "1.08em" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--x-color-signal)" },
  {
    tag: tags.monospace,
    fontFamily: "var(--x-font-mono)",
    backgroundColor: "var(--x-color-code-bg)",
    borderRadius: "var(--x-radius-sm)",
  },
  { tag: tags.quote, color: "var(--x-color-muted)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator, tags.list], color: "var(--x-color-muted)" },
]);

export function Editor(props: {
  value: string;
  onChange(v: string): void;
  onSave(): void;
  readOnly?: boolean;
  autoFocus?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // CodeMirror keeps the callbacks it was built with; refs let them see the latest props.
  const latest = useRef(props);
  latest.current = props;
  const editable = useRef(new Compartment());
  const label = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          Prec.high(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (latest.current.onSave(), true) }])),
          basicSetup,
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          editable.current.of(EditorState.readOnly.of(!!latest.current.readOnly)),
          label.current.of([]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            // Skip changes pushed in from props, so a reload does not echo back as an edit.
            if (text !== latest.current.value) latest.current.onChange(text);
          }),
        ],
      }),
    });
    view.current = v;
    if (latest.current.autoFocus) {
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      v.focus();
    }
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== props.value) v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(!!props.readOnly)) });
  }, [props.readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: label.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": t("editor.label") })),
    });
  }, [t]);

  return <div className="editor" ref={host} />;
}
