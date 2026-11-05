// Workspace keymap: key chords to action ids.

import { useEffect } from "react";
import { IS_MAC, PLATFORM, type Platform } from "@/platform";
import { getBindingsState } from "./bindingsStore";
import { docsShown } from "./docsShown";
import { normalizeChord } from "./keybindingsFile";
import { notifyTerminalKey } from "./terminalKey";
import { defaultsFor, SHORTCUTS } from "./registry";

export { subscribeBindings } from "./bindingsStore";

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
  | "worktree.history.back" | "worktree.history.forward"
  | `worktree.select.${Digit}`
  | "agent.new"
  | "palette.jump"
  | "search.open"
  | "sidebar.left.toggle" | "sidebar.right.toggle"
  | "panel.explorer" | "panel.search" | "panel.sourceControl" | "panel.issues" | "panel.ports"
  | "terminal.clear" | "terminal.copy" | "terminal.paste" | "terminal.selectAll" | "terminal.find"
  | "zoom.in" | "zoom.out" | "zoom.reset"
  | "tab.reopenClosed"
  | "settings.open" | "settings.shortcuts"
  | "sessions.open"
  | "docs.search" | "docs.new" | "docs.save"
  // Saves the file of the focused file tab; the handler declines when another tab is in front.
  | "file.save"
  // Opens the Markdown preview of the focused file tab; the handler declines for any other file.
  | "file.markdownPreview"
  // Bound to nothing by default; the quick-commands plan registers the handler.
  | "quickCommands.open"
  // Quick open: a file of the worktree on screen by name.
  | "quickOpen.open";

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

/** Store snapshot: every chord that is bound now, on this platform. */
export function effectiveBindings(): EffectiveBinding[] {
  return getBindingsState().bindings;
}

let suspended = false;

/** While on, every `useKeymap` handler does nothing (the shortcut recorder listens). */
export function suspendKeymap(on: boolean): void {
  suspended = on;
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

// The store holds this platform's bindings; another platform (tests, labels) gets its defaults.
const OTHER_PLATFORMS = new Map<Platform, Binding[]>();

function bindingsFor(p: Platform): readonly Binding[] {
  if (p === PLATFORM) return getBindingsState().bindings;
  let found = OTHER_PLATFORMS.get(p);
  if (!found) OTHER_PLATFORMS.set(p, (found = defaultBindings(p)));
  return found;
}

// Chord → actions, global ones first; rebuilt when the bindings it came from change.
const TABLES = new Map<Platform, { from: readonly Binding[]; table: Map<string, ActionId[]> }>();
const SCOPE_RANK = { global: 0, terminal: 1, docs: 2 } as const;
const DEF_OF = new Map(SHORTCUTS.map((d) => [d.id, d]));

function tableFor(p: Platform): Map<string, ActionId[]> {
  const from = bindingsFor(p);
  const cached = TABLES.get(p);
  if (cached?.from === from) return cached.table;
  const table = new Map<string, ActionId[]>();
  for (const b of from) {
    const list = table.get(b.chord) ?? [];
    if (!list.includes(b.action)) list.push(b.action);
    table.set(b.chord, list);
  }
  for (const list of table.values()) list.sort((a, b) => SCOPE_RANK[DEF_OF.get(a)!.scope] - SCOPE_RANK[DEF_OF.get(b)!.scope]);
  TABLES.set(p, { from, table });
  return table;
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

/**
 * Chords a focused terminal always keeps, even under "app first" (R5): interrupt, end of input,
 * suspend, history search and the readline keys. A binding on one still works outside a terminal.
 */
export const TERMINAL_KEEPS: readonly string[] = [
  "Ctrl+C", "Ctrl+D", "Ctrl+Z", "Ctrl+R", "Ctrl+N", "Ctrl+P", "Ctrl+A", "Ctrl+E", "Ctrl+U",
];

/**
 * The actions `e` may run while a terminal has focus, the winner first: terminal-scope ones shadow
 * global ones, docs-scope ones never apply. Under "terminal first" a key a TUI also uses stays with
 * the program; a key in `TERMINAL_KEEPS` always does.
 */
// Saving a file or previewing it means nothing in a terminal, so those keys stay the terminal's own there
// (Ctrl+Shift+V is its paste).
const EDITOR_ONLY: ReadonlySet<ActionId> = new Set<ActionId>(["file.save", "file.markdownPreview"]);

function terminalActions(e: KeyboardEvent, p: Platform): ActionId[] {
  const chord = eventChord(e, p);
  if (chord === null || TERMINAL_KEEPS.includes(chord)) return [];
  const yields = getBindingsState().keySettings.terminalPolicy === "terminal-first";
  const all = (tableFor(p).get(chord) ?? []).filter((a) => !EDITOR_ONLY.has(a) && !(yields && DEF_OF.get(a)!.yieldsToTerminal));
  return [...all.filter((a) => DEF_OF.get(a)!.scope === "terminal"), ...all.filter((a) => DEF_OF.get(a)!.scope === "global")];
}

/** The action `e` runs when it should leave a focused terminal and go to the app; null otherwise. */
export function appOwnsKey(e: KeyboardEvent, mac: boolean = IS_MAC): ActionId | null {
  return terminalActions(e, platformOf(mac))[0] ?? null;
}

function inTerminal(e: KeyboardEvent): boolean {
  const target = e.target as { closest?: (selector: string) => unknown } | null;
  return typeof target?.closest === "function" && target.closest(".xterm") !== null;
}

/**
 * The one action `e` runs here, if any. In a focused terminal: what `appOwnsKey` claims. Elsewhere a
 * docs-scope action shadows a global one while the docs view is shown; terminal-scope ones never apply.
 */
function winnerOf(e: KeyboardEvent, mac: boolean): ActionId | undefined {
  if (inTerminal(e)) return terminalActions(e, platformOf(mac))[0];
  const all = actionsOf(e, mac);
  const docs = all.filter((a) => DEF_OF.get(a)!.scope === "docs");
  const global = all.filter((a) => DEF_OF.get(a)!.scope === "global");
  return (docs.length > 0 && docsShown() ? docs[0] : undefined) ?? global[0];
}

const GLYPHS: Record<string, string> = {
  Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘", Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↵",
};

/** The chord of an action as shown to a person: "Ctrl+T", or "⌘T" on macOS. */
export function chordLabel(action: ActionId, mac: boolean = IS_MAC): string | null {
  const p = platformOf(mac);
  const found = bindingsFor(p).find((b) => b.action === action);
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
 * Handles bound chords in the capture phase on window. Only the winning action of a chord runs (see
 * `winnerOf`), so two views holding handlers for one chord do not both fire. A handler returning
 * false lets the key through. Ignored while an IME composes, while the keymap is suspended, when an
 * earlier listener already took the key, and (but for the palette key) while a modal dialog is open.
 * A text field does not block a chord: every default chord carries Ctrl, Alt or Cmd, so none of
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
      if (suspended || e.defaultPrevented) return;
      if (e.isComposing || e.keyCode === 229) return;
      const action = winnerOf(e, IS_MAC);
      const handler = action === undefined ? undefined : handlers[action];
      if (action === undefined || handler === undefined) return;
      if (opts?.when && !opts.when()) return;
      if (!WORKS_IN_DIALOG.has(action) && modalOpen()) return;
      // Held down, a chord is swallowed but does not fire again (Ctrl+W would close every tab).
      if (e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (handler() === false) return;
      if (inTerminal(e)) notifyTerminalKey(action, chordLabel(action));
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
}
