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

/** "ctrl+shift+t" → "Ctrl+Shift+T"; null is "Unable to parse shortcut.". */
export function normalizeChord(raw: string, p: Platform): string | null {
  void raw;
  void p;
  return null;
}

/** Chord → the actions sharing it, same scope only; chords with one action are left out. */
export function conflicts(bindings: EffectiveBinding[]): Map<string, ActionId[]> {
  void bindings;
  return new Map();
}
