// Where dictated text goes: the terminal, code editor or text field that had the focus when
// dictation started. Anything else, or a target that went away, gets the clipboard.

import { EditorView } from "@codemirror/view";
import { terminalHandleAt, type NodeLike } from "@/terminal/handleRegistry";
import type { TerminalHandle } from "@/terminal/Terminal";
import { copyText } from "@/ui/clipboard";

/** The part of a focused element the insert reads; a real `HTMLElement` fits. */
export interface TargetElement {
  tagName: string;
  isConnected: boolean;
  closest(selector: string): unknown;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  focus?(): void;
  setSelectionRange?(start: number, end: number): void;
  dispatchEvent?(event: Event): boolean;
}

/** The part of a CodeMirror `EditorView` the insert uses. */
export interface EditorViewLike {
  state: {
    readOnly: boolean;
    replaceSelection(text: string): object;
    selection: { main: { from: number } };
    sliceDoc(from: number, to: number): string;
  };
  dispatch(spec: object): void;
  focus?(): void;
}

export type TargetKind = "terminal" | "editor" | "text" | "none";

export interface Target {
  kind: TargetKind;
  el: TargetElement | null;
}

export type InsertResult = "inserted" | "copied" | "failed";

export interface InsertDeps {
  findView(el: TargetElement): EditorViewLike | null;
  copy(text: string): Promise<boolean>;
  /** `document.execCommand("insertText")` on the focused field; false when it did nothing. */
  execInsert(text: string): boolean;
  /** The native value setter, so React sees the change on the next `input` event. */
  setValue(el: TargetElement, value: string): void;
  terminalAt(el: TargetElement): TerminalHandle | null;
}

// Input types that hold free text.
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", ""]);

export function resolveTarget(el: TargetElement | null | undefined): Target {
  if (!el || !el.isConnected) return { kind: "none", el: null };
  if (el.closest(".xterm")) return { kind: "terminal", el };
  if (el.closest(".cm-editor")) return { kind: "editor", el };
  const tag = el.tagName.toUpperCase();
  const textual = tag === "TEXTAREA" || (tag === "INPUT" && TEXT_INPUTS.has((el.type ?? "text").toLowerCase()));
  if (textual && !el.disabled && !el.readOnly) return { kind: "text", el };
  return { kind: "none", el: null };
}

/** `text` with a leading space when `before` ends in a non-space character. */
export function joinSpacing(before: string, text: string): string {
  return before === "" || /\s$/.test(before) ? text : ` ${text}`;
}

/** `value` with `start..end` replaced by `text`, and the caret after it. */
export function spliceText(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}

async function copied(text: string, deps: InsertDeps): Promise<InsertResult> {
  return (await deps.copy(text)) ? "copied" : "failed";
}

function insertIntoField(el: TargetElement, text: string, deps: InsertDeps): void {
  const value = el.value ?? "";
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const spaced = joinSpacing(value.slice(0, start), text);
  el.focus?.();
  if (deps.execInsert(spaced)) return;
  const next = spliceText(value, start, end, spaced);
  deps.setValue(el, next.value);
  el.setSelectionRange?.(next.caret, next.caret);
  el.dispatchEvent?.(new Event("input", { bubbles: true }));
}

/** Puts `text` into `target`; the clipboard takes it when the target cannot. */
export async function insertDictation(target: Target, text: string, deps: InsertDeps): Promise<InsertResult> {
  const { el } = target;
  if (!el || !el.isConnected) return copied(text, deps);
  switch (target.kind) {
    case "terminal": {
      const handle = deps.terminalAt(el);
      if (!handle?.insertText) return copied(text, deps);
      handle.insertText(text);
      return "inserted";
    }
    case "editor": {
      const view = deps.findView(el);
      if (!view || view.state.readOnly) return copied(text, deps);
      const from = view.state.selection.main.from;
      const spaced = joinSpacing(view.state.sliceDoc(Math.max(0, from - 1), from), text);
      view.dispatch({ ...view.state.replaceSelection(spaced), userEvent: "input.dictate", scrollIntoView: true });
      view.focus?.();
      return "inserted";
    }
    case "text":
      insertIntoField(el, text, deps);
      return "inserted";
    default:
      return copied(text, deps);
  }
}

/** The production parts: CodeMirror, the clipboard, `execCommand` and the terminal registry. */
export const domInsertDeps: InsertDeps = {
  findView(el) {
    const host = el.closest(".cm-editor") as HTMLElement | null;
    return host ? (EditorView.findFromDOM(host) as unknown as EditorViewLike | null) : null;
  },
  copy: copyText,
  execInsert: (text) => {
    try {
      return document.execCommand("insertText", false, text);
    } catch {
      return false;
    }
  },
  setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  },
  terminalAt: (el) => terminalHandleAt(el as unknown as NodeLike),
};
