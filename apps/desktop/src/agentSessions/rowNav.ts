/** One stop in the flattened list: a group header (never focused) or a session row. */
export type NavItem = "header" | "row";

export type NavKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

export const NAV_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "Home", "End"];

/**
 * The index the focus moves to. Headers are skipped and the ends do not wrap: Down on the last row stays on it.
 * From no row (`-1`) Down and Home pick the first row, Up and End the last. `-1` when there is no row at all.
 */
export function nextRowIndex(items: readonly NavItem[], from: number, key: NavKey): number {
  const rows = items.flatMap((kind, i) => (kind === "row" ? [i] : []));
  if (rows.length === 0) return -1;
  if (key === "Home") return rows[0];
  if (key === "End") return rows[rows.length - 1];
  const at = rows.indexOf(from);
  if (at === -1) return key === "ArrowDown" ? rows[0] : rows[rows.length - 1];
  return rows[Math.min(rows.length - 1, Math.max(0, at + (key === "ArrowDown" ? 1 : -1)))];
}
