// Workspace keymap: key chords to action ids.
// Contract only: Lane U2 (feat/workspace-keys) implements chordOf and useKeymap.

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

/** Layout independent: uses e.code. Returns null for a key that is not a chord. */
export function chordOf(_e: KeyboardEvent, _mac: boolean): string | null {
  return null;
}

/** Handles bound chords in the capture phase on window. A handler returning false lets the key through. */
export function useKeymap(
  _handlers: Partial<Record<ActionId, () => boolean | void>>,
  _opts?: { when?: () => boolean },
): void {}
