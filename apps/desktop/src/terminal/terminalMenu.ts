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

/** The terminal's right-click items, in the reference order (plan U2). */
export function terminalMenuItems(ctx: TerminalMenuContext): MenuItem[] {
  // Contract stub: Lane U (U2).
  void ctx;
  return [];
}
