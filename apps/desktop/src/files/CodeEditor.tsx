import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { EditorSettings } from "@/api";
import { highlight, theme } from "@/components/Editor";
import { useI18n } from "@/i18n";
import type { Goto } from "./fileTabs";
import { conflictDecorations } from "./conflictDecorations";
import { selectionOf, type GutterSelection } from "./gutterMenu";
import { useEditorPlugins } from "./editorPlugins";
import { minimalChange } from "./textDiff";
import { languageOf, loadLanguage } from "./languages";

// Marks a change pushed in from props: it is not an edit, and it stays out of the undo history.
const remote = Annotation.define<boolean>();

const wrap = (on: boolean) => (on ? EditorView.lineWrapping : []);
const tabs = (size: number) => [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))];

/** A CodeMirror view of one file's text. The text is owned by the caller; edits come out of `onChange`. */
export function CodeEditor(props: {
  worktree: string;
  rel: string;
  /** The second view of a file: it shows the same text, and the caret jump (`goto`) is left to the file tab. */
  secondary?: boolean;
  value: string;
  settings: EditorSettings;
  goto?: Goto;
  onChange(text: string): void;
  onSave(): void;
  /** A right click on the line-number gutter: where, which line, and the multi-line selection if any. */
  onGutterMenu?(at: { x: number; y: number }, line: number, selection: GutterSelection | null): void;
}): JSX.Element {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const lang = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const indent = useRef(new Compartment());
  const label = useRef(new Compartment());
  const conflicts = useRef(new Compartment());
  const pluginSlot = useRef(new Compartment());
  const plugins = useEditorPlugins({ worktree: props.worktree, rel: props.rel, secondary: !!props.secondary });

  useEffect(() => {
    const s = latest.current.settings;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          Prec.high(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (latest.current.onSave(), true) }])),
          basicSetup,
          syntaxHighlighting(highlight),
          theme,
          lang.current.of([]),
          wrapping.current.of(wrap(s.wordWrap)),
          indent.current.of(tabs(s.tabSize)),
          label.current.of([]),
          conflicts.current.of([]),
          pluginSlot.current.of([]),
          EditorView.domEventHandlers({
            contextmenu(e, view) {
              const open = latest.current.onGutterMenu;
              if (!open || !(e.target instanceof Element) || !e.target.closest(".cm-gutters")) return false;
              const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
              e.preventDefault();
              open({ x: e.clientX, y: e.clientY }, view.state.doc.lineAt(block.from).number, selectionOf(view.state));
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.some((tr) => tr.annotation(remote))) return;
            const text = update.state.doc.toString();
            // A change pushed in from props (a reload) is not an edit.
            if (text !== latest.current.value) latest.current.onChange(text);
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const language = languageOf(props.rel);
    if (!language) return void view.current?.dispatch({ effects: lang.current.reconfigure([]) });
    let live = true;
    void loadLanguage(language).then(
      (ext) => live && view.current?.dispatch({ effects: lang.current.reconfigure(ext) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [props.rel]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    // The smallest change keeps this view's caret and scroll where they are while another view types.
    const change = minimalChange(current, props.value);
    if (change) v.dispatch({ changes: change, annotations: [Transaction.addToHistory.of(false), remote.of(true)] });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: pluginSlot.current.reconfigure(plugins) });
  }, [plugins]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap(props.settings.wordWrap)) });
  }, [props.settings.wordWrap]);

  useEffect(() => {
    view.current?.dispatch({ effects: indent.current.reconfigure(tabs(props.settings.tabSize)) });
  }, [props.settings.tabSize]);

  useEffect(() => {
    view.current?.dispatch({
      effects: label.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": t("editor.label") })),
    });
  }, [t]);

  // Conflict blocks of the text, with accept actions that edit the buffer; the labels follow the language.
  useEffect(() => {
    const labels = { bar: (n: number, total: number) => t("editor.conflict.bar", { n, total }), current: t("editor.conflict.current"), incoming: t("editor.conflict.incoming"), both: t("editor.conflict.both") };
    view.current?.dispatch({ effects: conflicts.current.reconfigure(conflictDecorations(() => labels)) });
  }, [t]);

  // A new `seq` moves the caret to the line, once the text is in.
  const seq = props.goto?.seq;
  useEffect(() => {
    const v = view.current;
    const g = latest.current.goto;
    if (!v || !g || latest.current.secondary) return;
    const line = v.state.doc.line(Math.max(1, Math.min(g.line, v.state.doc.lines)));
    const anchor = line.from + Math.max(0, Math.min((g.column ?? 1) - 1, line.length));
    v.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    v.focus();
  }, [seq]);

  return <div className="editor file-editor" ref={host} style={{ "--editor-font-size": `${props.settings.fontSize}px` } as React.CSSProperties} />;
}
