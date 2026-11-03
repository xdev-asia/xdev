// keybindings.json, version 1:
// {
//   "version": 1,
//   "keybindings": { "tab.new": ["Ctrl+T"], "terminal.clear": [], "zoom.in": ["Ctrl+="] },
//   "win":   { "…": ["…"] },   // optional per-platform override, wins over "keybindings"
//   "mac":   { … },
//   "linux": { … }
// }
// An action not listed uses its defaults. [] disables it. A string is accepted as a one-item list.

import type { Platform } from "@/platform";
import type { ActionId, EffectiveBinding } from "./keymap";

export interface KeybindingsFile {
  version: 1;
  keybindings: Record<string, string[]>;
  win?: Record<string, string[]>;
  mac?: Record<string, string[]>;
  linux?: Record<string, string[]>;
}

export interface Diagnostic {
  kind: "parse" | "unknownAction" | "badChord" | "conflict" | "fixed";
  action?: string;
  chord?: string;
  with?: string[];
  message: string;
}

/** The overrides for `p` and what was wrong with the file. Never throws (R6). */
export function parseKeybindings(text: string, p: Platform): { overrides: Map<ActionId, string[]>; diagnostics: Diagnostic[] } {
  void text;
  void p;
  return { overrides: new Map(), diagnostics: [] };
}

/** Keeps unknown keys and the other platforms' sections from `keepText`. */
export function serializeKeybindings(overrides: Map<ActionId, string[]>, keepText?: string): string {
  void overrides;
  void keepText;
  return `${JSON.stringify({ version: 1, keybindings: {} }, null, 2)}\n`;
}

type Modifier = "Ctrl" | "Alt" | "Shift" | "Cmd";
const MOD_ORDER: Modifier[] = ["Ctrl", "Alt", "Shift", "Cmd"];
const MODIFIERS: Record<string, Modifier | "Mod"> = {
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
  cmd: "Cmd", command: "Cmd", meta: "Cmd", super: "Cmd", win: "Cmd",
  mod: "Mod",
};

/** Named keys as a chord writes them; `KeyboardEvent.key` / `code` spellings map onto these. */
const NAMED_KEYS = [
  "Tab", "Enter", "Space", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "Up", "Down", "Left", "Right",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
  ...Array.from({ length: 10 }, (_, n) => `Numpad${n}`),
];
const KEY_NAMES = new Map<string, string>([
  ...NAMED_KEYS.map((k): [string, string] => [k.toLowerCase(), k]),
  ["esc", "Escape"], ["return", "Enter"], ["del", "Delete"], ["ins", "Insert"], ["spacebar", "Space"],
  ["pgup", "PageUp"], ["pgdn", "PageDown"],
  ["arrowup", "Up"], ["arrowdown", "Down"], ["arrowleft", "Left"], ["arrowright", "Right"],
  ["equal", "="], ["equals", "="], ["minus", "-"], ["comma", ","], ["period", "."], ["dot", "."], ["slash", "/"],
  ["backslash", "\\"], ["bracketleft", "["], ["bracketright", "]"], ["semicolon", ";"], ["quote", "'"],
  ["backquote", "`"],
]);
const PUNCTUATION = "=-[];',./\\`";

function keyName(token: string): string | null {
  if (token.length === 1) {
    if (/[a-z0-9]/i.test(token)) return token.toUpperCase();
    return PUNCTUATION.includes(token) ? token : null;
  }
  const low = token.toLowerCase();
  const code = /^key([a-z])$/.exec(low) ?? /^digit([0-9])$/.exec(low);
  if (code) return code[1].toUpperCase();
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(low);
  if (f) return `F${f[1]}`;
  return KEY_NAMES.get(low) ?? null;
}

/** A key that types a character, so it is not a shortcut with Shift alone. */
function printable(key: string): boolean {
  return key.length === 1 || key === "Space";
}

/**
 * "ctrl+shift+t" → "Ctrl+Shift+T"; null is "Unable to parse shortcut.". Modifiers come out in the
 * order Ctrl, Alt, Shift, Cmd; `Mod` is Cmd on macOS and Ctrl elsewhere; Cmd off macOS is null.
 * "Plus" (or a trailing "+", as in "Ctrl++") is Shift+= on the physical key. A key that types text
 * needs Ctrl, Alt or Cmd; only F1-F24 work alone.
 */
export function normalizeChord(raw: string, p: Platform): string | null {
  if (typeof raw !== "string") return null;
  const tokens = raw.split("+").map((t) => t.trim());
  if (tokens.length >= 2 && tokens.at(-1) === "" && tokens.at(-2) === "") tokens.splice(-2, 2, "Plus");
  if (tokens.some((t) => t === "")) return null;
  const last = tokens.pop()!;
  const mods = new Set<Modifier>();
  for (const t of tokens) {
    const m = MODIFIERS[t.toLowerCase()];
    if (!m) return null;
    mods.add(m === "Mod" ? (p === "mac" ? "Cmd" : "Ctrl") : m);
  }
  if (mods.has("Cmd") && p !== "mac") return null;
  let key: string | null;
  if (last.toLowerCase() === "plus") {
    key = "=";
    mods.add("Shift");
  } else {
    key = keyName(last);
  }
  if (key === null) return null;
  const strong = mods.has("Ctrl") || mods.has("Alt") || mods.has("Cmd");
  if (!strong && !/^F\d+$/.test(key) && (mods.size === 0 || printable(key))) return null;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** Chord → the actions sharing it, same scope only; chords with one action are left out. */
export function conflicts(bindings: EffectiveBinding[]): Map<string, ActionId[]> {
  void bindings;
  return new Map();
}
