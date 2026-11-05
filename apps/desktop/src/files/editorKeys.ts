import { type Extension, Prec } from "@codemirror/state";
import { type KeyBinding, keymap } from "@codemirror/view";

export type EditorKeyActions = {
  /** Alt+Z. */
  onToggleWrap: () => void;
  /** F7 (1) and Shift+F7 (-1). */
  onChange: (dir: 1 | -1) => void;
};

export function editorKeymap({ onToggleWrap, onChange }: EditorKeyActions): KeyBinding[] {
  return [
    { key: "Alt-z", run: () => (onToggleWrap(), true) },
    { key: "F7", run: () => (onChange(1), true) },
    { key: "Shift-F7", run: () => (onChange(-1), true) },
  ];
}

/** The editor's own keys, above the default keymap. */
export function editorKeys(actions: EditorKeyActions): Extension {
  return Prec.high(keymap.of(editorKeymap(actions)));
}
