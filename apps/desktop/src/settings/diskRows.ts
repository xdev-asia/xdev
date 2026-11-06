import type { HeavyDir, WorktreeUsage } from "@/api";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** "512 B", "1.5 KB", "2.0 MB", "3.2 GB". */
export function formatSize(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${n} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** The last two folders of a path: enough to tell worktrees apart. */
export function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

/** The paths Delete build folders removes: every heavy folder of the row, and nothing else. */
export function cleanTargets(row: WorktreeUsage): string[] {
  return row.heavy.map((h: HeavyDir) => h.path);
}

/** Bytes the heavy folders of a row hold. */
export function heavyTotal(row: WorktreeUsage): number {
  return row.heavy.reduce((sum, h) => sum + h.size, 0);
}

/** The rows after a clean: that row has nothing heavy left and its total is reduced; still sorted by size. */
export function afterClean(rows: WorktreeUsage[], worktree: string): WorktreeUsage[] {
  return rows
    .map((r) => (r.worktree === worktree ? { ...r, total: r.total - heavyTotal(r), heavy: [] } : r))
    .sort((a, b) => b.total - a.total || a.worktree.localeCompare(b.worktree));
}
