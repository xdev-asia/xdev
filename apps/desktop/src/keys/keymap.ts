// Workspace keymap: key chords to action ids.

import { useEffect } from "react";
import { IS_MAC, PLATFORM, type Platform } from "@/platform";
import { normalizeChord } from "./keybindingsFile";
import { defaultsFor, SHORTCUTS } from "./registry";

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
  | "palette.jump"
  | "search.open"
  | "sidebar.left.toggle" | "sidebar.right.toggle"
  | "panel.explorer" | "panel.search" | "panel.sourceControl"
  | "terminal.clear" | "terminal.copy" | "terminal.paste" | "terminal.selectAll" | "terminal.find"
  | "zoom.in" | "zoom.out" | "zoom.reset"
  | "tab.reopenClosed"
  | "settings.open" | "settings.shortcuts"
  | "docs.search" | "docs.new" | "docs.save"
  // Bound to nothing by default; the quick-commands plan registers the handler.
  | "quickCommands.open";

export interface Binding {
  action: ActionId;
  /** Normalized, as `normalizeChord` writes it: "Ctrl+Shift+D", "Cmd+J" on macOS. */
  chord: string;
}

/** The platform whose keys apply: macOS when `mac`, else the platform this runs on (Windows on a Mac). */
export function platformOf(mac: boolean): Platform {
  if (mac) return "mac";
  return PLATFORM === "mac" ? "win" : PLATFORM;
}

function defaultBindings(p: Platform): Binding[] {
  return SHORTCUTS.flatMap((d) =>
    defaultsFor(d, p).flatMap((raw) => {
      const chord = normalizeChord(raw, p);
      return chord === null ? [] : [{ action: d.id, chord }];
    }),
  );
}

/** The registry's default chords on this platform, normalized. */
export const DEFAULT_BINDINGS: Binding[] = defaultBindings(PLATFORM);

/** One chord of one action as it applies now: a default, or from `keybindings.json`. */
export interface EffectiveBinding {
  action: ActionId;
  chord: string;
  source: "default" | "user";
}

/** Store snapshot: every chord that is bound now. */
export function effectiveBindings(): EffectiveBinding[] {
  return DEFAULT_BINDINGS.map((b) => ({ action: b.action, chord: b.chord, source: "default" }));
}

/** Called after the effective bindings change. Returns the unsubscribe. */
export function subscribeBindings(fn: () => void): () => void {
  void fn;
  return () => {};
}

/** The action `e` runs when it should leave a focused terminal and go to the app; null otherwise. */
export function appOwnsKey(e: KeyboardEvent): ActionId | null {
  void e;
  return null;
}

/** While on, every `useKeymap` handler does nothing (the shortcut recorder listens). */
export function suspendKeymap(on: boolean): void {
  void on;
}

// `KeyboardEvent.code` to the key names chords use.
const NAMED: Record<string, string> = {
  Tab: "Tab",
  Enter: "Enter",
  NumpadEnter: "NumpadEnter",
  Space: "Space",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  NumpadAdd: "NumpadAdd",
  NumpadSubtract: "NumpadSubtract",
  NumpadMultiply: "NumpadMultiply",
  NumpadDivide: "NumpadDivide",
  NumpadDecimal: "NumpadDecimal",
};

function keyOf(e: KeyboardEvent): string | null {
  const code = e.code;
  // A synthetic event may carry no code; fall back to the character.
  if (!code) return typeof e.key === "string" && /^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase() : null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code) || /^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/**
 * Layout independent: uses e.code. Returns null for a key that is not a chord (no modifier, or a
 * key outside the set bindings use). Modifier order is Ctrl, Mod (Cmd, macOS only), Alt, Shift.
 */
export function chordOf(e: KeyboardEvent, mac: boolean): string | null {
  const key = keyOf(e);
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

/** The chord of `e` as `normalizeChord` writes it for `p`; null when it is no shortcut there. */
export function eventChord(e: KeyboardEvent, p: Platform): string | null {
  const key = keyOf(e);
  if (key === null) return null;
  if (e.metaKey && p !== "mac") return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Cmd");
  return normalizeChord([...parts, key].join("+"), p);
}

// Chord → actions, global ones first; one table per platform, built on first use.
const TABLES = new Map<Platform, Map<string, ActionId[]>>();
const SCOPE_RANK = { global: 0, terminal: 1, docs: 2 } as const;
const SCOPE_OF = new Map(SHORTCUTS.map((d) => [d.id, d.scope]));

function tableFor(p: Platform): Map<string, ActionId[]> {
  let found = TABLES.get(p);
  if (!found) {
    found = new Map();
    for (const b of defaultBindings(p)) found.set(b.chord, [...(found.get(b.chord) ?? []), b.action]);
    for (const list of found.values()) list.sort((a, b) => SCOPE_RANK[SCOPE_OF.get(a)!] - SCOPE_RANK[SCOPE_OF.get(b)!]);
    TABLES.set(p, found);
  }
  return found;
}

/** Every action bound to the chord of `e`, global ones first. */
export function actionsOf(e: KeyboardEvent, mac: boolean = IS_MAC): ActionId[] {
  const p = platformOf(mac);
  const chord = eventChord(e, p);
  return chord === null ? [] : (tableFor(p).get(chord) ?? []);
}

/** The action a key event is bound to, if any; a global one before a scoped one. */
export function actionOf(e: KeyboardEvent, mac: boolean = IS_MAC): ActionId | null {
  return actionsOf(e, mac)[0] ?? null;
}

const GLYPHS: Record<string, string> = {
  Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘", Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↵",
};

/** The chord of an action as shown to a person: "Ctrl+T", or "⌘T" on macOS. */
export function chordLabel(action: ActionId, mac: boolean = IS_MAC): string | null {
  const p = platformOf(mac);
  const found = defaultBindings(p).find((b) => b.action === action);
  if (!found) return null;
  const parts = found.chord.split("+");
  if (!mac) return parts.join("+");
  return parts.map((part) => GLYPHS[part] ?? part).join("");
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
    // The effect runs again each render, so a view that is hidden holds no listener at all.
    if (opts?.when && !opts.when()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const action = actionsOf(e).find((a) => handlers[a]);
      if (action === undefined) return;
      const handler = handlers[action]!;
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
