import { chordLabel, type ActionId } from "@/keys/keymap";
import type { Tab } from "@/workspace/sessions";
import type { MenuItem } from "@/ui/ContextMenu";
import type { TerminalHandle } from "./Terminal";

/** What the terminal menu acts on. */
export interface TerminalMenuContext {
  handle: TerminalHandle;
  tab: Tab;
  /** The pane holding the tab; null without a pane tree (Copy Pane ID is then hidden). */
  paneId: string | null;
  split(dir: "right" | "down"): void;
  /** Opens the tab title dialog. */
  setTitle(): void;
  close(): void;
  copyContext(): void;
  copyTerminalId(): void;
  copyPaneId(): void;
  /** The Quick Commands submenu (`quickCommandsSubmenu`), shown before Copy Context; absent hides it. */
  quickCommands?: MenuItem;
  /**
   * Opens a copy of this agent session in a new tab. Absent for a shell and for CLIs without a fork
   * (the item is hidden); the item is disabled while the tab has no session id yet.
   */
  forkSession?(): void;
  /** Opens the hand off dialog: the same work given to another agent. Absent hides the item. */
  handOff?(): void;
}

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

// The chord the keys registry binds to an action now (a rebound key shows too), or nothing.
const chord = (action: ActionId): string | undefined => chordLabel(action) ?? undefined;

/**
 * The terminal's right-click items, in the reference order (plan U2): the items that have an action
 * show its chord, and the Quick Commands submenu sits before Copy Context.
 * Fork session sits between Quick Commands and Copy Context.
 */
export function terminalMenuItems(ctx: TerminalMenuContext): MenuItem[] {
  const { handle } = ctx;
  return [
    { id: "copy", labelKey: "termMenu.copy", chord: chord("terminal.copy"), disabled: !handle.hasSelection(), run: () => void handle.copy() },
    { id: "paste", labelKey: "termMenu.paste", chord: chord("terminal.paste"), run: () => void handle.paste() },
    { id: "selectAll", labelKey: "termMenu.selectAll", chord: chord("terminal.selectAll"), run: () => handle.selectAll() },
    SEP("sep1"),
    ...(ctx.quickCommands ? [ctx.quickCommands] : []),
    ...(ctx.forkSession ? [{ id: "forkSession", labelKey: "termMenu.forkSession", disabled: !ctx.tab.agentSession, run: ctx.forkSession }] : []),
    ...(ctx.handOff ? [{ id: "handOff", labelKey: "termMenu.handOff", run: ctx.handOff }] : []),
    { id: "copyContext", labelKey: "termMenu.copyContext", run: ctx.copyContext },
    SEP("sep2"),
    { id: "splitRight", labelKey: "termMenu.splitRight", chord: chord("pane.splitRight"), run: () => ctx.split("right") },
    { id: "splitDown", labelKey: "termMenu.splitDown", chord: chord("pane.splitDown"), run: () => ctx.split("down") },
    SEP("sep3"),
    { id: "setTitle", labelKey: "termMenu.setTitle", run: ctx.setTitle },
    { id: "copyTerminalId", labelKey: "termMenu.copyTerminalId", run: ctx.copyTerminalId },
    ...(ctx.paneId ? [{ id: "copyPaneId", labelKey: "termMenu.copyPaneId", run: ctx.copyPaneId }] : []),
    SEP("sep4"),
    { id: "clear", labelKey: "termMenu.clearScreen", chord: chord("terminal.clear"), run: () => handle.clear() },
    { id: "reset", labelKey: "termMenu.resetTerminal", run: () => handle.reset() },
    SEP("sep5"),
    { id: "close", labelKey: "termMenu.close", chord: chord("tab.close"), run: ctx.close },
  ];
}
