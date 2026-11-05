import type { Cost } from "@/api";
import { localDay, totalOf, type Tokens } from "./kitUi";

/** Days the Overview heatmap shows: six full weeks. */
export const RECENT_DAYS = 42;

export type Level = 0 | 1 | 2 | 3 | 4;

/** Share of the input-side tokens that came from the cache: `read / (input + read + write)`; `null` when there are none. */
export function cacheReuse(t: Tokens): number | null {
  const base = t.input + t.cache_read + t.cache_write;
  return base === 0 ? null : t.cache_read / base;
}

/** `n/a` when no token was priced, `$0.0042` under a cent, else `$12.34`. */
export function formatCost(c: Cost): string {
  if (!c.priced) return "n/a";
  const usd = c.nanos / 1e9;
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** A level from a share of the busiest day: 0 is none, then each quarter up to and including 25 %, 50 %, 75 %. */
function levelOf(total: number, max: number): Level {
  if (total <= 0 || max <= 0) return 0;
  const ratio = total / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** The last `count` local days ending on `now`, oldest first; a day with no entry is level 0. */
export function recentDays(days: [string, Tokens][], count: number, now: Date): { day: string; total: number; level: Level }[] {
  const byDay = new Map(days.map(([day, tk]) => [day, totalOf(tk)] as const));
  const list: { day: string; total: number }[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    list.push({ day, total: byDay.get(day) ?? 0 });
  }
  const max = Math.max(0, ...list.map((d) => d.total));
  return list.map((d) => ({ ...d, level: levelOf(d.total, max) }));
}

/** The day with the most tokens (above zero); the earlier one on a tie. */
export function bestDay(days: [string, Tokens][]): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [day, tk] of days) {
    const total = totalOf(tk);
    if (total > most || (total === most && total > 0 && best !== null && day < best)) {
      best = day;
      most = total;
    }
  }
  return best;
}
