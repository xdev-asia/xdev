// Workspace keymap: key chords to action ids.

import { useEffect } from "react";
import { IS_MAC } from "@/platform";

type Digit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type ActionId =
  | "tab.new"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | `tab.select.${Digit}`
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.next"
  | "pane.prev"
  | "pane.expand"
  | "pane.equalize"
  | "pane.close"
  | "worktree.next"
  | "worktree.prev"
  | `worktree.select.${Digit}`
  | "agent.new"
  | "palette.jump";

export interface Binding {
  action: ActionId;
  /** "Ctrl+Shift+D", "Mod+J". Mod is Ctrl, Cmd on macOS. */
  chord: string;
}

const DIGITS: Digit[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const DEFAULT_BINDINGS: Binding[] = [
  { action: "tab.new", chord: "Ctrl+T" },
  { action: "tab.close", chord: "Ctrl+W" },
  { action: "tab.next", chord: "Ctrl+Tab" },
  { action: "tab.prev", chord: "Ctrl+Shift+Tab" },
  ...DIGITS.map((n): Binding => ({ action: `tab.select.${n}`, chord: `Alt+${n}` })),
  { action: "pane.splitRight", chord: "Ctrl+Shift+D" },
  { action: "pane.splitDown", chord: "Alt+Shift+D" },
  { action: "pane.next", chord: "Ctrl+]" },
  { action: "pane.prev", chord: "Ctrl+[" },
  { action: "pane.expand", chord: "Ctrl+Shift+Enter" },
  { action: "pane.equalize", chord: "Ctrl+Shift+=" },
  { action: "worktree.prev", chord: "Ctrl+Shift+Up" },
  { action: "worktree.next", chord: "Ctrl+Shift+Down" },
  ...DIGITS.map((n): Binding => ({ action: `worktree.select.${n}`, chord: `Ctrl+${n}` })),
  { action: "agent.new", chord: "Ctrl+Alt+T" },
  { action: "palette.jump", chord: "Mod+J" },
];

const NAMED: Record<string, string> = {
  Tab: "Tab",
  Enter: "Enter",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
};

function keyOf(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return NAMED[code] ?? null;
}

/**
 * Layout independent: uses e.code. Returns null for a key that is not a chord (no modifier, or a
 * key outside the set bindings use). Modifier order is Ctrl, Mod (Cmd, macOS only), Alt, Shift.
 */
export function chordOf(e: KeyboardEvent, mac: boolean): string | null {
  const key = keyOf(e.code);
  if (key === null) return null;
  if (e.metaKey && !mac) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null;
  return [...parts, key].join("+");
}

/** A binding chord in the form `chordOf` produces: Mod is Ctrl off macOS. */
function normalize(chord: string, mac: boolean): string {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "Mod" && !mac ? "Ctrl" : p)));
  return [...["Ctrl", "Mod", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}

function table(bindings: Binding[], mac: boolean): Map<string, ActionId> {
  return new Map(bindings.map((b) => [normalize(b.chord, mac), b.action]));
}

const TABLES = { mac: table(DEFAULT_BINDINGS, true), other: table(DEFAULT_BINDINGS, false) };

/** The action a key event is bound to, if any. */
export function actionOf(e: KeyboardEvent, mac: boolean = IS_MAC): ActionId | null {
  const chord = chordOf(e, mac);
  return chord === null ? null : ((mac ? TABLES.mac : TABLES.other).get(chord) ?? null);
}

/** The chord of an action as shown to a person: "Ctrl+T", or "⌘T" on macOS. */
export function chordLabel(action: ActionId, mac: boolean = IS_MAC): string | null {
  const found = DEFAULT_BINDINGS.find((b) => b.action === action);
  if (!found) return null;
  const parts = normalize(found.chord, mac).split("+");
  if (!mac) return parts.join("+");
  const glyph: Record<string, string> = { Ctrl: "⌃", Mod: "⌘", Alt: "⌥", Shift: "⇧", Up: "↑", Down: "↓", Enter: "↵" };
  return parts.map((p) => glyph[p] ?? p).join("");
}

// The kept keys open the palette and a new agent; the dialog check does not apply to the palette,
// which closes itself with the same key.
const WORKS_IN_DIALOG: ReadonlySet<ActionId> = new Set(["palette.jump"]);

function modalOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Handles bound chords in the capture phase on window. A handler returning false lets the key
 * through. Ignored while an IME composes, and (but for the palette key) while a modal dialog is
 * open. A text field does not block a chord: every default chord carries Ctrl or Alt, so none of
 * them types text, and the terminal's own input is a text field.
 */
export function useKeymap(
  handlers: Partial<Record<ActionId, () => boolean | void>>,
  opts?: { when?: () => boolean },
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const action = actionOf(e);
      if (action === null) return;
      const handler = handlers[action];
      if (!handler) return;
      if (opts?.when && !opts.when()) return;
      if (!WORKS_IN_DIALOG.has(action) && modalOpen()) return;
      // Held down, a chord is swallowed but does not fire again (Ctrl+W would close every tab).
      if (e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (handler() === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
}
