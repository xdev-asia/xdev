// What the Shortcuts page shows and the edits it makes, as plain functions over the bindings state.

import type { BindingsState } from "@/keys/bindingsStore";
import { conflicts, normalizeChord } from "@/keys/keybindingsFile";
import type { ActionId } from "@/keys/keymap";
import { defaultsFor, SHORTCUTS, type ShortcutDef } from "@/keys/registry";
import { PLATFORM } from "@/platform";

export type ShortcutFilter = "all" | "modified" | "unassigned" | "conflicts";
export const FILTERS: ShortcutFilter[] = ["all", "modified", "unassigned", "conflicts"];

export interface ShortcutRow {
  def: ShortcutDef;
  /** The chords that apply now. */
  chords: string[];
  /** The file changes this action (including switching it off). */
  modified: boolean;
  /** The file asks for no chord at all. */
  disabled: boolean;
  /** One of its chords is also bound to another action in the same scope. */
  conflict: boolean;
}

export function defaultChords(def: ShortcutDef): string[] {
  return defaultsFor(def, PLATFORM).map((c) => normalizeChord(c, PLATFORM)).filter((c): c is string => c !== null);
}

/** Every action as a row, in registry order. */
export function buildRows(state: BindingsState): ShortcutRow[] {
  const clash = new Set<string>();
  for (const [chord, actions] of conflicts(state.bindings)) for (const a of actions) clash.add(`${a} ${chord}`);
  return SHORTCUTS.map((def) => {
    const chords = state.bindings.filter((b) => b.action === def.id).map((b) => b.chord);
    const override = state.overrides.get(def.id);
    return {
      def,
      chords,
      modified: override !== undefined,
      disabled: override !== undefined && override.length === 0,
      conflict: chords.some((c) => clash.has(`${def.id} ${c}`)),
    };
  });
}

/** Rows that match `query` (action id, its words, or a chord) and the chip. */
export function filterRows(rows: ShortcutRow[], query: string, filter: ShortcutFilter, title: (def: ShortcutDef) => string): ShortcutRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "modified" && !r.modified) return false;
    if (filter === "unassigned" && r.chords.length > 0) return false;
    if (filter === "conflicts" && !r.conflict) return false;
    if (q === "") return true;
    return [r.def.id, title(r.def), ...r.chords].some((s) => s.toLowerCase().includes(q));
  });
}

export function countRows(rows: ShortcutRow[]): Record<ShortcutFilter, number> {
  return {
    all: rows.length,
    modified: rows.filter((r) => r.modified).length,
    unassigned: rows.filter((r) => r.chords.length === 0).length,
    conflicts: rows.filter((r) => r.conflict).length,
  };
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** `overrides` with `chords` for `id`; the defaults themselves are no override. */
export function withChords(overrides: Map<ActionId, string[]>, id: ActionId, chords: string[]): Map<ActionId, string[]> {
  const next = new Map(overrides);
  const def = SHORTCUTS.find((d) => d.id === id);
  if (def && same(chords, defaultChords(def))) next.delete(id);
  else next.set(id, [...chords]);
  return next;
}

/** Other actions in the same scope that hold `chord` now. */
export function clashes(rows: ShortcutRow[], id: ActionId, chord: string): ActionId[] {
  const scope = SHORTCUTS.find((d) => d.id === id)?.scope;
  return rows.filter((r) => r.def.id !== id && r.def.scope === scope && r.chords.includes(chord)).map((r) => r.def.id);
}

/** Adds `chord` to `id`; with `replace`, the actions holding it lose it first. */
export function addChord(overrides: Map<ActionId, string[]>, rows: ShortcutRow[], id: ActionId, chord: string, replace: boolean): Map<ActionId, string[]> {
  let next = overrides;
  if (replace) {
    for (const other of clashes(rows, id, chord)) {
      const had = rows.find((r) => r.def.id === other)!.chords;
      next = withChords(next, other, had.filter((c) => c !== chord));
    }
  }
  const mine = rows.find((r) => r.def.id === id)!.chords;
  return withChords(next, id, mine.includes(chord) ? mine : [...mine, chord]);
}

export function removeChord(overrides: Map<ActionId, string[]>, rows: ShortcutRow[], id: ActionId, chord: string): Map<ActionId, string[]> {
  const mine = rows.find((r) => r.def.id === id)!.chords;
  return withChords(overrides, id, mine.filter((c) => c !== chord));
}

export const disableAction = (overrides: Map<ActionId, string[]>, id: ActionId) => withChords(overrides, id, []);

export function resetAction(overrides: Map<ActionId, string[]>, id: ActionId): Map<ActionId, string[]> {
  const next = new Map(overrides);
  next.delete(id);
  return next;
}
