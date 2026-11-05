import type { WorkStatus } from "@/api";
import type { MenuItem } from "@/ui/ContextMenu";

/** A column of the board: a work status, or `none` for a worktree without one. */
export type ColumnId = WorkStatus | "none";

/** The work statuses in the order the sidebar's status menu lists them. */
export const STATUSES: readonly WorkStatus[] = ["todo", "in-progress", "in-review", "completed"];

/** The columns left to right: each status, then the worktrees with none. */
export const COLUMN_IDS: readonly ColumnId[] = [...STATUSES, "none"];

/** How far the pointer must travel from where it went down before a press becomes a drag. */
export const DRAG_THRESHOLD = 6;

export interface Column<T> {
  id: ColumnId;
  items: T[];
}

/** The column of a status; a status this build does not know sits in `none`. */
export function columnOf(status: string | null | undefined): ColumnId {
  return STATUSES.find((s) => s === status) ?? "none";
}

/** The status a column sets; `none` clears it. */
export function statusOf(column: ColumnId): WorkStatus | null {
  return column === "none" ? null : column;
}

/**
 * Every column, in order, with the worktrees under it in their given order. `overrides` holds the
 * statuses a move has set but the list has not yet read back (null is "No status").
 */
export function groupByStatus<T extends { path: string; status: string | null }>(
  worktrees: readonly T[],
  overrides: Readonly<Record<string, WorkStatus | null>> = {},
): Column<T>[] {
  const columns = COLUMN_IDS.map((id): Column<T> => ({ id, items: [] }));
  for (const wt of worktrees) {
    const status = wt.path in overrides ? overrides[wt.path] : wt.status;
    columns[COLUMN_IDS.indexOf(columnOf(status))].items.push(wt);
  }
  return columns;
}

export interface Point {
  x: number;
  y: number;
}

/** Whether the pointer has left the press point by more than `threshold` pixels. */
export function pastThreshold(from: Point, to: Point, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > threshold;
}

export interface ColumnBox {
  id: ColumnId;
  left: number;
  right: number;
}

/** The column under a pointer x, or null when it is left or right of every column. */
export function dropColumn(x: number, boxes: readonly ColumnBox[]): ColumnId | null {
  return boxes.find((b) => x >= b.left && x < b.right)?.id ?? null;
}

/** The "Move to" items of a card: the same choices as the sidebar's status menu, the current one checked. */
export function moveItems(current: string | null, onMove: (status: WorkStatus | null) => void): MenuItem[] {
  const at = columnOf(current);
  return [
    ...STATUSES.map((s): MenuItem => ({ id: `status:${s}`, labelKey: `workspace.work.${s}`, checked: at === s, run: () => onMove(s) })),
    { id: "status:none", labelKey: "workspace.groupBy.status.none", checked: at === "none", run: () => onMove(null) },
  ];
}

export interface MoveHooks {
  /** Shows the card in its new column before the write returns. */
  apply(path: string, status: WorkStatus | null): void;
  /** Drops the shown column: the list read back after a write, or the write failed and the card goes home. */
  settle(path: string): void;
  /** The write; rejects when it fails. */
  write(): Promise<void>;
}

/**
 * Moves a card at once and writes in the background. Resolves true when the write held and false
 * when it failed (the card is back where it was). A move to the column it is in does nothing.
 */
export async function moveCard(wt: { path: string; status: string | null }, to: WorkStatus | null, hooks: MoveHooks): Promise<boolean> {
  if (columnOf(wt.status) === columnOf(to)) return true;
  hooks.apply(wt.path, to);
  try {
    await hooks.write();
    return true;
  } catch {
    return false;
  } finally {
    hooks.settle(wt.path);
  }
}
