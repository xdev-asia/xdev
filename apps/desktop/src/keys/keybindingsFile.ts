// keybindings.json, version 1:
// {
//   "version": 1,
//   "keybindings": { "tab.new": ["Ctrl+T"], "terminal.clear": [], "zoom.in": ["Ctrl+="] },
//   "win":   { "…": ["…"] },   // optional per-platform override, wins over "keybindings"
//   "mac":   { … },
//   "linux": { … }
// }
// An action not listed uses its defaults. [] disables it. A string is accepted as a one-item list.

import { PLATFORM, type Platform } from "@/platform";
import type { ActionId, EffectiveBinding } from "./keymap";
import { defaultsFor, shortcutDef, SHORTCUTS } from "./registry";

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

const PLATFORMS: Platform[] = ["win", "mac", "linux"];

/**
 * Removes line and block comments and trailing commas outside strings, as hand-edited files have
 * them; a leading BOM goes too.
 */
function stripJsonc(text: string): string {
  let out = "";
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The file as an object; null with a diagnostic when it is not one. Empty text is an empty file. */
function readObject(text: string, diagnostics: Diagnostic[]): Record<string, unknown> | null {
  const body = stripJsonc(text);
  if (body.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (e) {
    diagnostics.push({ kind: "parse", message: `keybindings.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
  if (!isRecord(value)) {
    diagnostics.push({ kind: "parse", message: "keybindings.json must hold an object." });
    return null;
  }
  return value;
}

/** The entries for `p`: the shared section in file order, each replaced by the platform section's. */
function entriesFor(file: Record<string, unknown>, p: Platform): [string, unknown][] {
  const shared = isRecord(file.keybindings) ? file.keybindings : {};
  const own = isRecord(file[p]) ? file[p] : {};
  const out = new Map<string, unknown>(Object.entries(shared));
  for (const [k, v] of Object.entries(own)) out.set(k, v);
  return [...out];
}

/** The overrides for `p` and what was wrong with the file. Never throws (R6). */
export function parseKeybindings(text: string, p: Platform): { overrides: Map<ActionId, string[]>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const overrides = new Map<ActionId, string[]>();
  const file = readObject(text, diagnostics);
  if (file === null) return { overrides, diagnostics };
  if (file.version !== undefined && file.version !== 1) {
    diagnostics.push({ kind: "parse", message: `Unknown version ${JSON.stringify(file.version)}; read as version 1.` });
  }
  // "scope chord" → the action whose override took it first.
  const taken = new Map<string, ActionId>();
  for (const [action, value] of entriesFor(file, p)) {
    const def = shortcutDef(action as ActionId);
    if (!def) {
      diagnostics.push({ kind: "unknownAction", action, message: `Unknown action "${action}".` });
      continue;
    }
    if (def.fixed) {
      diagnostics.push({ kind: "fixed", action, message: `${action} cannot be rebound.` });
      continue;
    }
    const raw = typeof value === "string" ? [value] : value;
    if (!Array.isArray(raw)) {
      diagnostics.push({ kind: "badChord", action, message: `${action} needs a list of shortcuts.` });
      continue;
    }
    const chords: string[] = [];
    for (const item of raw) {
      const chord = typeof item === "string" ? normalizeChord(item, p) : null;
      if (chord === null) {
        const shown = typeof item === "string" ? item : JSON.stringify(item);
        diagnostics.push({ kind: "badChord", action, chord: shown, message: `Unable to parse shortcut "${shown}" for ${action}.` });
        continue;
      }
      const owner = taken.get(`${def.scope} ${chord}`);
      if (owner !== undefined) {
        diagnostics.push({
          kind: "conflict", action, chord, with: [owner],
          message: `${chord} is already bound to ${owner}; dropped from ${action}.`,
        });
        continue;
      }
      if (!chords.includes(chord)) chords.push(chord);
    }
    // A list left with no chord after bad or taken ones keeps the defaults; only [] disables.
    if (chords.length === 0 && raw.length > 0) continue;
    for (const chord of chords) taken.set(`${def.scope} ${chord}`, def.id);
    overrides.set(def.id, chords);
  }
  // A user chord on another action's default in the same scope: both kept, the default loses.
  for (const [key, losers] of defaultsLost(overrides, p)) {
    const owner = taken.get(key)!;
    const chord = key.slice(key.indexOf(" ") + 1);
    diagnostics.push({
      kind: "conflict", action: owner, chord, with: losers,
      message: `${chord} of ${owner} replaces the default of ${losers.join(", ")}.`,
    });
  }
  return { overrides, diagnostics };
}

/** "scope chord" → the actions whose default chord a user override takes there. */
function defaultsLost(overrides: Map<ActionId, string[]>, p: Platform): Map<string, ActionId[]> {
  const user = new Set<string>();
  for (const [action, chords] of overrides) {
    const scope = shortcutDef(action)?.scope ?? "global";
    for (const chord of chords) user.add(`${scope} ${chord}`);
  }
  const lost = new Map<string, ActionId[]>();
  for (const def of SHORTCUTS) {
    if (overrides.has(def.id)) continue;
    for (const raw of defaultsFor(def, p)) {
      const key = `${def.scope} ${normalizeChord(raw, p)}`;
      if (user.has(key)) lost.set(key, [...(lost.get(key) ?? []), def.id]);
    }
  }
  return lost;
}

/**
 * Every chord that applies on `p`: the registry's defaults, an override in place of its action's
 * defaults, and no default chord that another action's override took in the same scope.
 */
export function mergeBindings(overrides: Map<ActionId, string[]>, p: Platform): EffectiveBinding[] {
  const lost = defaultsLost(overrides, p);
  const out: EffectiveBinding[] = [];
  for (const def of SHORTCUTS) {
    const user = overrides.get(def.id);
    if (user) {
      for (const chord of user) out.push({ action: def.id, chord, source: "user" });
      continue;
    }
    for (const raw of defaultsFor(def, p)) {
      const chord = normalizeChord(raw, p);
      if (chord === null || lost.has(`${def.scope} ${chord}`)) continue;
      out.push({ action: def.id, chord, source: "default" });
    }
  }
  return out;
}

function sameChords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function sorted(section: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(section).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The file with `overrides` for `p`: only actions that differ from their defaults, in this
 * platform's section when the action is there already, else in the shared one (Cmd written as
 * Mod so it reads on every platform). Keeps unknown keys and the other platforms' sections from
 * `keepText`; two-space JSON, sorted by action id. A `keepText` that does not parse is dropped.
 */
export function serializeKeybindings(overrides: Map<ActionId, string[]>, keepText?: string, p: Platform = PLATFORM): string {
  const kept = (keepText === undefined ? null : readObject(keepText, [])) ?? {};
  const keptOwn = isRecord(kept[p]) ? kept[p] : null;
  const shared: Record<string, unknown> = isRecord(kept.keybindings) ? { ...kept.keybindings } : {};
  const own: Record<string, unknown> | null = keptOwn ? { ...keptOwn } : null;
  // Known actions are written again from `overrides` (absent is the defaults); unknown keys stay.
  for (const def of SHORTCUTS) {
    const defaults = defaultsFor(def, p).map((c) => normalizeChord(c, p)).filter((c): c is string => c !== null);
    const chords = overrides.get(def.id) ?? defaults;
    const isDefault = sameChords(chords, defaults);
    if (own && def.id in own) {
      // The shared entry stays for the other platforms; here the defaults must then be written out.
      if (isDefault && !(def.id in shared)) delete own[def.id];
      else own[def.id] = [...chords];
    } else if (isDefault) {
      delete shared[def.id];
    } else {
      shared[def.id] = chords.map((c) => c.split("+").map((part) => (part === "Cmd" ? "Mod" : part)).join("+"));
    }
  }
  const out: Record<string, unknown> = { version: 1, keybindings: sorted(shared) };
  for (const q of PLATFORMS) {
    if (q === p) {
      if (own) out[q] = sorted(own);
    } else if (kept[q] !== undefined) {
      out[q] = kept[q];
    }
  }
  for (const [key, value] of Object.entries(kept)) {
    if (!(key in out) && key !== "version") out[key] = value;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
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
  const byScope = new Map<string, ActionId[]>();
  for (const b of bindings) {
    const key = `${shortcutDef(b.action)?.scope ?? "global"} ${b.chord}`;
    const list = byScope.get(key) ?? [];
    if (!list.includes(b.action)) list.push(b.action);
    byScope.set(key, list);
  }
  const out = new Map<string, ActionId[]>();
  for (const [key, actions] of byScope) {
    if (actions.length < 2) continue;
    const chord = key.slice(key.indexOf(" ") + 1);
    out.set(chord, [...(out.get(chord) ?? []), ...actions]);
  }
  return out;
}
