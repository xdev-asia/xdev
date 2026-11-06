import type { MenuItem } from "@/ui/ContextMenu";
import { TAB_COLORS, type Tab, type TabColor } from "./sessions";

/** The four sides a tab can move to: a new pane opens on that side of its own. */
export type MoveDir = "left" | "right" | "up" | "down";

/** The edge of a pane a move in `dir` drops on (the drop zones' names). */
export function moveEdge(dir: MoveDir): "left" | "right" | "top" | "bottom" {
  return dir === "up" ? "top" : dir === "down" ? "bottom" : dir;
}

/** The Move to Split children, in menu order. */
function moveItems(move: (dir: MoveDir) => void): MenuItem[] {
  const item = (dir: MoveDir, key: string): MenuItem => ({ id: key, labelKey: `tabMenu.${key}`, run: () => move(dir) });
  return [item("left", "moveLeft"), item("right", "moveRight"), item("up", "moveUp"), item("down", "moveDown")];
}

/** What the tab menu acts on. */
export interface TabMenuContext {
  tab: Tab;
  /** The tabs of the worktree, in strip order. */
  tabs: Tab[];
  canMoveToSplit: boolean;
  split(dir: "right" | "down"): void;
  moveToSplit(dir: MoveDir): void;
  setPinned(pinned: boolean): void;
  copyTabId(): void;
  /** Opens the tab title dialog. */
  changeTitle(): void;
  setColor(color: TabColor): void;
  close(): void;
  closeOthers(): void;
  closeToRight(): void;
  /** Closes every unpinned terminal and file tab of the worktree. */
  closeAll(): void;
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
      children: moveItems(ctx.moveToSplit),
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
    { id: "closeAll", labelKey: "tabMenu.closeAll", disabled: !ctx.tabs.some((t) => !t.pinned), run: ctx.closeAll },
  ];
}

/** One tab of the worktree as Close all sees it. */
export interface CloseAllTab {
  id: string;
  /** Only terminal (and agent) and file tabs close; the review, commit and preview tabs stay. */
  kind: "terminal" | "file" | "other";
  pinned: boolean;
}

/** The tabs Close all takes: every terminal, agent and file tab that is not pinned. */
export function closeAllTargets(tabs: readonly CloseAllTab[]): string[] {
  return tabs.filter((t) => t.kind !== "other" && !t.pinned).map((t) => t.id);
}

/** The colour token of a tab colour (`c3` -> `--x-tab-color-3`); null for "none". */
export function tabColorVar(color: TabColor): string | null {
  return color === "none" ? null : `--x-tab-color-${color.slice(1)}`;
}

/** One open file tab as the file menu sees it. */
export interface FileTabInfo {
  rel: string;
  dirty: boolean;
  pinned: boolean;
}

/** What the file tab menu acts on. */
export interface FileTabMenuContext {
  /** The file tab the menu is for. */
  rel: string;
  /** The file tabs of the pane, in strip order. */
  files: FileTabInfo[];
  canMoveToSplit: boolean;
  /** Set for a Markdown file that can open as a preview; absent for any other file. */
  openPreview?: () => void;
  /** Shows the file a second time, in a new pane on that side. */
  splitView(dir: "right" | "down"): void;
  moveToSplit(dir: MoveDir): void;
  setPinned(pinned: boolean): void;
  copyPath(): void;
  copyRelativePath(): void;
  close(): void;
  closeOthers(): void;
  closeToRight(): void;
  closeSaved(): void;
  closeAll(): void;
}

export type FileCloseKind = "others" | "right" | "saved" | "all";

/**
 * The file tabs a bulk close takes: every one of `kind` except pinned tabs. `rel` is the tab the menu
 * was opened on (unused for "saved" and "all").
 */
export function fileCloseTargets(files: readonly FileTabInfo[], rel: string | null, kind: FileCloseKind): string[] {
  const at = rel === null ? -1 : files.findIndex((f) => f.rel === rel);
  return files
    .filter((f, i) => {
      if (f.pinned) return false;
      if (kind === "others") return f.rel !== rel;
      if (kind === "right") return i > at;
      if (kind === "saved") return !f.dirty;
      return true;
    })
    .map((f) => f.rel);
}

/** The right-click items of a file tab: terminal-only items (id, title, colour) are left out. */
export function fileTabMenuItems(ctx: FileTabMenuContext): MenuItem[] {
  const me = ctx.files.find((f) => f.rel === ctx.rel);
  const pinned = !!me?.pinned;
  const has = (kind: FileCloseKind) => fileCloseTargets(ctx.files, ctx.rel, kind).length > 0;
  return [
    ...(ctx.openPreview ? [{ id: "openPreview", labelKey: "tabMenu.openPreview", run: ctx.openPreview }, SEP("sep-preview")] : []),
    { id: "splitRight", labelKey: "tabMenu.splitRight", run: () => ctx.splitView("right") },
    { id: "splitDown", labelKey: "tabMenu.splitDown", run: () => ctx.splitView("down") },
    SEP("sep-split"),
    {
      id: "moveToSplit",
      labelKey: "tabMenu.moveToSplit",
      disabled: !ctx.canMoveToSplit,
      children: moveItems(ctx.moveToSplit),
    },
    SEP("sep1"),
    pinned
      ? { id: "pin", labelKey: "tabMenu.unpin", run: () => ctx.setPinned(false) }
      : { id: "pin", labelKey: "tabMenu.pin", run: () => ctx.setPinned(true) },
    SEP("sep2"),
    { id: "copyPath", labelKey: "tabMenu.copyPath", run: ctx.copyPath },
    { id: "copyRelativePath", labelKey: "tabMenu.copyRelativePath", run: ctx.copyRelativePath },
    SEP("sep3"),
    { id: "close", labelKey: "tabMenu.close", run: ctx.close },
    { id: "closeOthers", labelKey: "tabMenu.closeOthers", disabled: !has("others"), run: ctx.closeOthers },
    { id: "closeToRight", labelKey: "tabMenu.closeToRight", disabled: !has("right"), run: ctx.closeToRight },
    { id: "closeSaved", labelKey: "tabMenu.closeSaved", disabled: !has("saved"), run: ctx.closeSaved },
    { id: "closeAll", labelKey: "tabMenu.closeAll", disabled: !has("all"), run: ctx.closeAll },
  ];
}

/** What the menu of a view tab (the second view of a file) acts on. */
export interface ViewTabMenuContext {
  close(): void;
  copyPath(): void;
  copyRelativePath(): void;
}

/** The right-click items of a view tab: Close view, then the path copies. */
export function viewTabMenuItems(ctx: ViewTabMenuContext): MenuItem[] {
  return [
    { id: "closeView", labelKey: "tabMenu.closeView", run: ctx.close },
    SEP("sep1"),
    { id: "copyPath", labelKey: "tabMenu.copyPath", run: ctx.copyPath },
    { id: "copyRelativePath", labelKey: "tabMenu.copyRelativePath", run: ctx.copyRelativePath },
  ];
}

/**
 * The tab after (`1`) or before (`-1`) `current` among the tabs of the same kind as `current`,
 * wrapping. Null when `current` is not in `ids`, or it is the only tab of its kind.
 */
export function cycleSameKind(
  ids: readonly string[],
  current: string | null,
  step: 1 | -1,
  kindOf: (id: string) => string,
): string | null {
  if (current === null || !ids.includes(current)) return null;
  const kind = kindOf(current);
  const same = ids.filter((id) => kindOf(id) === kind);
  if (same.length < 2) return null;
  return same[(same.indexOf(current) + step + same.length) % same.length];
}
