import type { MenuItem } from "@/ui/ContextMenu";
import { TAB_COLORS, type Tab, type TabColor } from "./sessions";

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

const SEP = (id: string): MenuItem => ({ id, labelKey: "", kind: "separator" });

/** The tab's right-click items, in SCR-14 order (plan U3). */
export function tabMenuItems(ctx: TabMenuContext): MenuItem[] {
  const at = ctx.tabs.findIndex((t) => t.id === ctx.tab.id);
  // Pinned tabs are skipped by the bulk closes; nothing left to close disables the item.
  const others = ctx.tabs.some((t) => t.id !== ctx.tab.id && !t.pinned);
  const right = ctx.tabs.slice(at + 1).some((t) => !t.pinned);
  return [
    { id: "splitRight", labelKey: "tabMenu.splitRight", run: () => ctx.split("right") },
    { id: "splitDown", labelKey: "tabMenu.splitDown", run: () => ctx.split("down") },
    {
      id: "moveToSplit",
      labelKey: "tabMenu.moveToSplit",
      disabled: !ctx.canMoveToSplit,
      children: [
        { id: "moveRight", labelKey: "tabMenu.moveRight", run: () => ctx.moveToSplit("right") },
        { id: "moveDown", labelKey: "tabMenu.moveDown", run: () => ctx.moveToSplit("down") },
      ],
    },
    SEP("sep1"),
    ctx.tab.pinned
      ? { id: "pin", labelKey: "tabMenu.unpin", run: () => ctx.setPinned(false) }
      : { id: "pin", labelKey: "tabMenu.pin", run: () => ctx.setPinned(true) },
    { id: "copyTabId", labelKey: "tabMenu.copyTabId", run: ctx.copyTabId },
    SEP("sep2"),
    { id: "changeTitle", labelKey: "tabMenu.changeTitle", run: ctx.changeTitle },
    {
      id: "color",
      labelKey: "tabMenu.color",
      children: TAB_COLORS.map((color) => ({
        id: color,
        labelKey: `tabMenu.color.${color}`,
        checked: ctx.tab.color === color,
        swatch: tabColorVar(color) ?? undefined,
        run: () => ctx.setColor(color),
      })),
    },
    SEP("sep3"),
    { id: "close", labelKey: "tabMenu.close", run: ctx.close },
    { id: "closeOthers", labelKey: "tabMenu.closeOthers", disabled: !others, run: ctx.closeOthers },
    { id: "closeToRight", labelKey: "tabMenu.closeToRight", disabled: !right, run: ctx.closeToRight },
  ];
}

/** The colour token of a tab colour (`c3` -> `--x-tab-color-3`); null for "none". */
export function tabColorVar(color: TabColor): string | null {
  return color === "none" ? null : `--x-tab-color-${color.slice(1)}`;
}
