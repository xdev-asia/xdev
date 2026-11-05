import { parentOf } from "./treeActions";

/** The part of a visible row the keys need; notes are left out by the caller. */
export interface NavRow {
  path: string;
  dir: boolean;
  open: boolean;
  depth: number;
}

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Home" | "End";

/** What a key asks of the tree: move the selection, open or close a folder, or open a file. */
export type NavResult =
  | { kind: "select"; path: string }
  | { kind: "expand"; path: string }
  | { kind: "collapse"; path: string }
  | { kind: "open"; path: string }
  | { kind: "toggle"; path: string };

export const NAV_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Home", "End"];

/** The result of `key` with `current` selected over the visible `rows`; null when the key does nothing. */
export function navigate(rows: NavRow[], current: string | null, key: NavKey): NavResult | null {
  if (rows.length === 0) return null;
  const at = current === null ? -1 : rows.findIndex((r) => r.path === current);
  const select = (i: number): NavResult => ({ kind: "select", path: rows[Math.min(rows.length - 1, Math.max(0, i))]!.path });
  switch (key) {
    case "Home":
      return select(0);
    case "End":
      return select(rows.length - 1);
    case "ArrowDown":
      return select(at + 1);
    case "ArrowUp":
      return select(at < 0 ? 0 : at - 1);
  }
  const row = rows[at];
  if (!row) return select(0);
  if (key === "Enter") return row.dir ? { kind: "toggle", path: row.path } : { kind: "open", path: row.path };
  if (key === "ArrowRight") {
    if (!row.dir) return null;
    if (!row.open) return { kind: "expand", path: row.path };
    // Into the folder: its first child is the next row, one level deeper.
    const next = rows[at + 1];
    return next && next.depth > row.depth ? { kind: "select", path: next.path } : null;
  }
  if (row.dir && row.open) return { kind: "collapse", path: row.path };
  const parent = rows.find((r) => r.dir && r.path === parentOf(row.path));
  return parent ? { kind: "select", path: parent.path } : null;
}
