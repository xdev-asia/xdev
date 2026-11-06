// Every app shortcut, in one list: what it is called, where it runs and its default keys.
// `keymap.ts` builds the effective bindings from this list plus `keybindings.json`.

import type { Platform } from "@/platform";
import type { ActionId } from "./keymap";

export type { Platform };

export type ShortcutGroup =
  | "tabs" | "panes" | "worktrees" | "agents" | "terminal" | "view" | "panels" | "docs" | "editor" | "app";

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

type Digit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
const DIGITS: Digit[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function def(
  id: ActionId,
  group: ShortcutGroup,
  defaults: ShortcutDef["defaults"] | string[],
  more: Partial<Pick<ShortcutDef, "scope" | "yieldsToTerminal" | "fixed">> = {},
): ShortcutDef {
  return {
    id,
    titleKey: `keys.action.${id}`,
    group,
    defaults: Array.isArray(defaults) ? { all: defaults } : defaults,
    scope: more.scope ?? "global",
    ...(more.yieldsToTerminal ? { yieldsToTerminal: true } : {}),
    ...(more.fixed ? { fixed: true } : {}),
  };
}

// `Mod` turns into Cmd on macOS; a plain `Ctrl` stays the physical Ctrl there (Ctrl+Tab is the
// system's tab key, and Ctrl+Alt+T already was Ctrl before the registry).
const TUI = { yieldsToTerminal: true } as const;
const TERMINAL = { scope: "terminal" } as const;
const DOCS = { scope: "docs" } as const;

export const SHORTCUTS: ShortcutDef[] = [
  // Tabs.
  def("tab.new", "tabs", ["Mod+T"]),
  def("tab.close", "tabs", ["Mod+W"]),
  // Ctrl+Tab opens the recent-tab switcher (MRU order); the other chords walk the strip. Ctrl stays Ctrl on macOS.
  def("tab.next", "tabs", ["Ctrl+Tab", "Mod+Shift+]", "Ctrl+PageDown"]),
  def("tab.prev", "tabs", ["Ctrl+Shift+Tab", "Mod+Shift+[", "Ctrl+PageUp"]),
  ...DIGITS.map((n) => def(`tab.select.${n}`, "tabs", [`Alt+${n}`])),
  def("tab.reopenClosed", "tabs", ["Mod+Shift+T"]),
  def("tab.nextSameKind", "tabs", ["Mod+Alt+]"]),
  def("tab.prevSameKind", "tabs", ["Mod+Alt+["]),
  def("tab.moveLeft", "tabs", ["Mod+Shift+PageUp"]),
  def("tab.moveRight", "tabs", ["Mod+Shift+PageDown"]),
  def("tab.closeAll", "tabs", ["Mod+Alt+W"]),
  def("browser.new", "tabs", ["Mod+Shift+B"]),
  // Panes.
  def("pane.splitRight", "panes", ["Mod+Shift+D"], TUI),
  def("pane.splitDown", "panes", ["Alt+Shift+D"], TUI),
  def("pane.next", "panes", ["Mod+]"], TUI),
  def("pane.prev", "panes", ["Mod+["], TUI),
  def("pane.expand", "panes", ["Mod+Shift+Enter"]),
  def("pane.equalize", "panes", ["Mod+Shift+="]),
  def("pane.close", "panes", ["Mod+Shift+W"], TUI),
  def("pane.clearTitle", "panes", []),
  // Worktrees.
  def("worktree.prev", "worktrees", ["Mod+Shift+Up"]),
  def("worktree.next", "worktrees", ["Mod+Shift+Down"]),
  def("worktree.history.back", "worktrees", ["Mod+Alt+Left"], TUI),
  def("worktree.history.forward", "worktrees", ["Mod+Alt+Right"], TUI),
  ...DIGITS.map((n) => def(`worktree.select.${n}`, "worktrees", [`Mod+${n}`])),
  // Agents.
  def("agent.new", "agents", ["Ctrl+Alt+T"]),
  def("tab.toggleChat", "agents", []),
  // Terminal: only with a terminal focused.
  def("terminal.clear", "terminal", ["Mod+K"], { ...TERMINAL, ...TUI }),
  def("terminal.copy", "terminal", { all: ["Ctrl+Shift+C"], mac: ["Cmd+C"] }, TERMINAL),
  def("terminal.paste", "terminal", { all: ["Ctrl+Shift+V", "Shift+Insert"], mac: ["Cmd+V"] }, TERMINAL),
  def("terminal.selectAll", "terminal", ["Mod+Shift+A"], { ...TERMINAL, ...TUI }),
  def("terminal.find", "terminal", ["Mod+F"], { ...TERMINAL, ...TUI }),
  // Not Mod+Up/Down: on macOS Cmd+Up/Down already scroll to the top and the bottom.
  def("terminal.prevPrompt", "terminal", ["Mod+Alt+Up"], { ...TERMINAL, ...TUI }),
  def("terminal.nextPrompt", "terminal", ["Mod+Alt+Down"], { ...TERMINAL, ...TUI }),
  // View. Zoom in has no Ctrl+Shift+= by default: Panes › Equalize has held it since panes-tabs-keys.
  def("sidebar.left.toggle", "view", ["Mod+B"]),
  def("sidebar.right.toggle", "view", ["Mod+L"]),
  def("sidebar.sleepingOnly.toggle", "view", []),
  def("sidebar.visibility.open", "view", []),
  def("zoom.in", "view", ["Mod+=", "Mod+NumpadAdd"]),
  def("zoom.out", "view", ["Mod+-", "Mod+NumpadSubtract"]),
  def("zoom.reset", "view", ["Mod+0"]),
  // Panels.
  def("panel.explorer", "panels", ["Mod+Shift+E"]),
  def("panel.search", "panels", ["Mod+Shift+F"]),
  def("panel.sourceControl", "panels", ["Mod+Shift+G"]),
  def("panel.issues", "panels", []),
  // Shift+I is free on macOS (the menu keeps Alt+Cmd+I for devtools); elsewhere it is the browser devtools chord.
  def("panel.ports", "panels", { mac: ["Mod+Shift+I"] }),
  // Docs: only in the docs view.
  def("docs.search", "docs", ["Mod+K"], DOCS),
  def("docs.new", "docs", ["Mod+N"], DOCS),
  def("docs.save", "docs", ["Mod+S"], DOCS),
  // Editor: a file tab in front; the tabs view declines the key otherwise.
  def("file.save", "editor", ["Mod+S"]),
  def("file.markdownPreview", "editor", ["Mod+Shift+V"]),
  def("file.splitRight", "editor", ["Mod+\\"]),
  def("file.splitDown", "editor", ["Mod+Alt+\\"]),
  def("file.closeAll", "editor", []),
  // App.
  def("palette.jump", "app", ["Mod+J"]),
  def("quickOpen.open", "app", ["Mod+P"]),
  def("search.open", "app", ["Mod+K"]),
  def("settings.open", "app", ["Mod+,"]),
  def("settings.shortcuts", "app", []),
  def("sessions.open", "app", []),
  def("quickCommands.open", "app", ["Mod+Shift+;"]),
  def("composer.open", "agents", ["Mod+Shift+M"]),
  def("floating.toggle", "view", ["Mod+Alt+A"]),
  // Not Mod+E off macOS: Ctrl+E is readline's end of line, which a focused terminal keeps.
  def("dictation.toggle", "app", { mac: ["Mod+E"], all: ["Ctrl+Shift+Space"] }),
];

/** The default chords of `def` on `p`, as written in the list (not normalized). */
export function defaultsFor(def: ShortcutDef, p: Platform): string[] {
  return def.defaults[p] ?? def.defaults.all ?? [];
}

const BY_ID = new Map(SHORTCUTS.map((d) => [d.id, d]));

/** The registry entry of `id`. */
export function shortcutDef(id: ActionId): ShortcutDef | undefined {
  return BY_ID.get(id);
}
