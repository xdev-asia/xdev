import type { MenuItem } from "@/ui/ContextMenu";
import type { Tab, TabColor } from "./sessions";

/** What the tab menu acts on. */
export interface TabMenuContext {
  tab: Tab;
  /** The tabs of the worktree, in strip order. */
  tabs: Tab[];
  canMoveToSplit: boolean;
  split(dir: "right" | "down"): void;
  moveToSplit(dir: "right" | "down"): void;
  setPinned(pinned: boolean): void;
  copyTabId(): void;
  /** Opens the tab title dialog. */
  changeTitle(): void;
  setColor(color: TabColor): void;
  close(): void;
  closeOthers(): void;
  closeToRight(): void;
}

/** The tab's right-click items, in SCR-14 order (plan U3). */
export function tabMenuItems(ctx: TabMenuContext): MenuItem[] {
  // Contract stub: Lane U (U3).
  void ctx;
  return [];
}
