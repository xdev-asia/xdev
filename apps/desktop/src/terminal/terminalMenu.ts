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
}

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

/**
 * The terminal's right-click items, in the reference order (plan U2).
 * TODO(plan 2026-11-03-terminal-context-menu, U2): chord labels once the keys registry is merged, and
 * the Quick Commands submenu (before Copy Context) once the quick-commands plan is merged.
 * Fork Agent Session is P2 (A9) and is not built here.
 */
export function terminalMenuItems(ctx: TerminalMenuContext): MenuItem[] {
  const { handle } = ctx;
  return [
    { id: "copy", labelKey: "termMenu.copy", disabled: !handle.hasSelection(), run: () => void handle.copy() },
    { id: "paste", labelKey: "termMenu.paste", run: () => void handle.paste() },
    { id: "selectAll", labelKey: "termMenu.selectAll", run: () => handle.selectAll() },
    SEP("sep1"),
    { id: "copyContext", labelKey: "termMenu.copyContext", run: ctx.copyContext },
    SEP("sep2"),
    { id: "splitRight", labelKey: "termMenu.splitRight", run: () => ctx.split("right") },
    { id: "splitDown", labelKey: "termMenu.splitDown", run: () => ctx.split("down") },
    SEP("sep3"),
    { id: "setTitle", labelKey: "termMenu.setTitle", run: ctx.setTitle },
    { id: "copyTerminalId", labelKey: "termMenu.copyTerminalId", run: ctx.copyTerminalId },
    ...(ctx.paneId ? [{ id: "copyPaneId", labelKey: "termMenu.copyPaneId", run: ctx.copyPaneId }] : []),
    SEP("sep4"),
    { id: "clear", labelKey: "termMenu.clearScreen", run: () => handle.clear() },
    { id: "reset", labelKey: "termMenu.resetTerminal", run: () => handle.reset() },
    SEP("sep5"),
    { id: "close", labelKey: "termMenu.close", run: ctx.close },
  ];
}
