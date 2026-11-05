import type { RunRow, RunTotals, RunsRange } from "@/api";
import { formatCost } from "@/kit/usageStats";

export const RANGES: readonly RunsRange[] = ["24h", "7d", "30d"];

export type DashSortKey = "started" | "cost";
export type DashSort = { key: DashSortKey; dir: "asc" | "desc" };

/** Newest first, the order the backend sends. */
export const DEFAULT_SORT: DashSort = { key: "started", dir: "desc" };

/** The first click on a column sorts it descending; the next flips it; a third returns to the default. */
export function nextSort(sort: DashSort, key: DashSortKey): DashSort {
  if (sort.key !== key) return { key, dir: "desc" };
  if (sort.dir === "desc") return { key, dir: "asc" };
  return DEFAULT_SORT;
}

/** The cost a row sorts by; `null` when it has no priced usage. */
function costOf(row: RunRow): number | null {
  return row.usage && row.usage.cost.priced ? row.usage.cost.nanos : null;
}

/** A sorted copy. A run with no known cost (or start) sorts last in either direction, never as zero. */
export function sortRows(rows: readonly RunRow[], sort: DashSort): RunRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = (r: RunRow) => (sort.key === "cost" ? costOf(r) : r.startedAt);
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y);
  });
}

/** `ok / (ok + failed)` as a whole percent; `null` when no run has ended either way. */
export function successRate(t: RunTotals): number | null {
  const ended = t.ok + t.failed;
  return ended === 0 ? null : Math.round((t.ok / ended) * 100);
}

export const UNKNOWN = "-";

export function tokensText(row: RunRow, format: (n: number) => string): string {
  return row.usage ? format(row.usage.tokensIn + row.usage.tokensOut + row.usage.tokensCache) : UNKNOWN;
}

export function costText(row: RunRow): string {
  return row.usage && row.usage.cost.priced ? formatCost(row.usage.cost) : UNKNOWN;
}

/** The totals' tokens; `-` when no run has usage. */
export function totalTokensText(t: RunTotals, format: (n: number) => string): string {
  return t.withUsage === 0 ? UNKNOWN : format(t.tokens);
}

export function totalCostText(t: RunTotals): string {
  return t.withUsage === 0 || !t.cost.priced ? UNKNOWN : formatCost(t.cost);
}

/** "2m 05s", "45s", "1h 03m"; `-` when the run has no duration. */
export function durationText(ms: number | null): string {
  if (ms === null) return UNKNOWN;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${two(m)}m`;
  if (m > 0) return `${m}m ${two(s)}s`;
  return `${s}s`;
}
