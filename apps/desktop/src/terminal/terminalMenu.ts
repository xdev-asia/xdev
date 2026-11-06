import { chordLabel, type ActionId } from "@/keys/keymap";
import type { Tab } from "@/workspace/sessions";
import type { MenuItem } from "@/ui/ContextMenu";
import type { ChipKind, ChipPrefs } from "./chips/chipPrefs";
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
  /** Switches this chat-capable agent tab to its chat. Absent hides Show chat. */
  showChat?(): void;
  /** Opens the hand off dialog: the same work given to another agent. Absent hides the item. */
  handOff?(): void;
  /** Sets every split of the worktree to equal sizes. Absent hides Equalize. */
  equalize?(): void;
  /** Toggles this pane to fill the area. Absent hides Expand. */
  expand?(): void;
  /** Whether this pane is the expanded one now (Expand shows checked). */
  expanded?: boolean;
  /** Gives the tab back the program's title. Absent hides Clear pane title. */
  clearTitle?(): void;
  /** Copies the tab's agent session id. Absent hides Copy session ID. */
  copySessionId?(): void;
  /** Opens the tab's sticky note. Absent hides Sticky note. */
  openNote?(): void;
  /** Opens the task editor on the selected text ("Create task from selection"). Absent hides the item. */
  onCreateTask?: (text: string) => void;
  /** Which header chips show now, and the switch of one; absent hides the Header chips submenu. */
  chips?: { prefs: ChipPrefs; toggle(kind: ChipKind): void };
}

/** Whether Clear pane title shows: only a title set by hand can be cleared. */
export const showsClearTitle = (tab: Pick<Tab, "renamed">): boolean => tab.renamed;

/** Whether Copy session ID shows: only a tab whose agent has reported a session. */
export const showsCopySessionId = (tab: Pick<Tab, "agentSession">): boolean => !!tab.agentSession;

/** Whether Equalize and Expand show: they need more than one pane to mean anything. */
export const showsPaneLayout = (paneCount: number): boolean => paneCount > 1;

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

// The chord the keys registry binds to an action now (a rebound key shows too), or nothing.
const chord = (action: ActionId): string | undefined => chordLabel(action) ?? undefined;

/** The Header chips submenu: one checked row per chip that shows. */
function chipsSubmenu(chips: NonNullable<TerminalMenuContext["chips"]>): MenuItem {
  const row = (kind: ChipKind): MenuItem => ({ id: `chip-${kind}`, labelKey: `paneChips.menu.${kind}`, checked: chips.prefs[kind], run: () => chips.toggle(kind) });
  return { id: "headerChips", labelKey: "paneChips.menu", children: [row("quota"), row("context"), row("timer")] };
}

/** Create task from selection: disabled while nothing is selected. */
function createTaskItem(ctx: TerminalMenuContext, create: (text: string) => void): MenuItem {
  const { handle } = ctx;
  return {
    id: "createTask",
    labelKey: "board.capture",
    disabled: !handle.hasSelection(),
    run: () => {
      const text = handle.selectionText?.() ?? "";
      if (text.trim()) create(text);
    },
  };
}

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
    ...(ctx.showChat ? [{ id: "showChat", labelKey: "termMenu.showChat", chord: chord("tab.toggleChat"), run: ctx.showChat }] : []),
    ...(ctx.quickCommands ? [ctx.quickCommands] : []),
    ...(ctx.forkSession ? [{ id: "forkSession", labelKey: "termMenu.forkSession", disabled: !ctx.tab.agentSession, run: ctx.forkSession }] : []),
    ...(ctx.handOff ? [{ id: "handOff", labelKey: "termMenu.handOff", run: ctx.handOff }] : []),
    { id: "copyContext", labelKey: "termMenu.copyContext", run: ctx.copyContext },
    ...(ctx.onCreateTask ? [createTaskItem(ctx, ctx.onCreateTask)] : []),
    SEP("sep2"),
    { id: "splitRight", labelKey: "termMenu.splitRight", chord: chord("pane.splitRight"), run: () => ctx.split("right") },
    { id: "splitDown", labelKey: "termMenu.splitDown", chord: chord("pane.splitDown"), run: () => ctx.split("down") },
    ...(ctx.equalize ? [{ id: "equalize", labelKey: "termMenu.equalize", chord: chord("pane.equalize"), run: ctx.equalize }] : []),
    ...(ctx.expand ? [{ id: "expand", labelKey: "termMenu.expand", chord: chord("pane.expand"), checked: !!ctx.expanded, run: ctx.expand }] : []),
    SEP("sep3"),
    { id: "setTitle", labelKey: "termMenu.setTitle", run: ctx.setTitle },
    ...(ctx.clearTitle && showsClearTitle(ctx.tab) ? [{ id: "clearTitle", labelKey: "termMenu.clearTitle", chord: chord("pane.clearTitle"), run: ctx.clearTitle }] : []),
    { id: "copyTerminalId", labelKey: "termMenu.copyTerminalId", run: ctx.copyTerminalId },
    ...(ctx.paneId ? [{ id: "copyPaneId", labelKey: "termMenu.copyPaneId", run: ctx.copyPaneId }] : []),
    ...(ctx.copySessionId && showsCopySessionId(ctx.tab) ? [{ id: "copySessionId", labelKey: "termMenu.copySessionId", run: ctx.copySessionId }] : []),
    ...(ctx.openNote || ctx.chips ? [SEP("sepChrome")] : []),
    ...(ctx.openNote ? [{ id: "stickyNote", labelKey: "notes.menu.open", run: ctx.openNote }] : []),
    ...(ctx.chips ? [chipsSubmenu(ctx.chips)] : []),
    SEP("sep4"),
    { id: "clear", labelKey: "termMenu.clearScreen", chord: chord("terminal.clear"), run: () => handle.clear() },
    { id: "reset", labelKey: "termMenu.resetTerminal", run: () => handle.reset() },
    SEP("sep5"),
    { id: "close", labelKey: "termMenu.close", chord: chord("tab.close"), run: ctx.close },
  ];
}
