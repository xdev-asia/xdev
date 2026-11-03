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
}

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

// The chord the keys registry binds to an action now (a rebound key shows too), or nothing.
const chord = (action: ActionId): string | undefined => chordLabel(action) ?? undefined;

/**
 * The terminal's right-click items, in the reference order (plan U2): the items that have an action
 * show its chord, and the Quick Commands submenu sits before Copy Context.
 * Fork Agent Session is P2 (A9) and is not built here.
 */
export function terminalMenuItems(ctx: TerminalMenuContext): MenuItem[] {
  const { handle } = ctx;
  return [
    { id: "copy", labelKey: "termMenu.copy", chord: chord("terminal.copy"), disabled: !handle.hasSelection(), run: () => void handle.copy() },
    { id: "paste", labelKey: "termMenu.paste", chord: chord("terminal.paste"), run: () => void handle.paste() },
    { id: "selectAll", labelKey: "termMenu.selectAll", chord: chord("terminal.selectAll"), run: () => handle.selectAll() },
    SEP("sep1"),
    ...(ctx.quickCommands ? [ctx.quickCommands] : []),
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
