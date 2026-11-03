// Every app shortcut, in one list: what it is called, where it runs and its default keys.
// `keymap.ts` builds the effective bindings from this list plus `keybindings.json`.

import type { Platform } from "@/platform";
import type { ActionId } from "./keymap";

export type { Platform };

export type ShortcutGroup =
  | "tabs" | "panes" | "worktrees" | "agents" | "terminal" | "view" | "panels" | "docs" | "app";

export interface ShortcutDef {
  id: ActionId;
  /** i18n key, prefix "keys.action.". */
  titleKey: string;
  group: ShortcutGroup;
  /** Chords per platform, `all` for the rest; `[]` is no default key. `Mod` is Ctrl, Cmd on macOS. */
  defaults: Partial<Record<Platform, string[]>> & { all?: string[] };
  /**
   * Where it runs: "global" anywhere in the window; "terminal" only with a terminal focused;
   * "docs" only in the docs view.
   */
  scope: "global" | "terminal" | "docs";
  /** With the terminal focused and policy "terminal-first", this key goes to the program (TUI). */
  yieldsToTerminal?: boolean;
  /** Never rebindable (Escape in dialogs etc.). Shown read-only. */
  fixed?: boolean;
}

/** Filled by the registry lane; one entry per `ActionId`. */
export const SHORTCUTS: ShortcutDef[] = [];

/** The default chords of `def` on `p`, as written in the list (not normalized). */
export function defaultsFor(def: ShortcutDef, p: Platform): string[] {
  return def.defaults[p] ?? def.defaults.all ?? [];
}
