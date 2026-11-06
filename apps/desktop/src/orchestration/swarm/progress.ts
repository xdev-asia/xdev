import type { SwarmRow } from "@/api";

export const SWARM_DEFAULT = 4;
export const SWARM_MAX = 12;

/** The count a swarm starts with: the default for none, else held between 1 and 12. */
export function clampCount(text: string): number {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return SWARM_DEFAULT;
  return Math.min(Math.max(n, 1), SWARM_MAX);
}

const ENDED = new Set(["succeeded", "failed", "stopped", "abandoned"]);

export const isLive = (row: SwarmRow): boolean => !ENDED.has(row.state);

export function counts(rows: SwarmRow[]): { live: number; ended: number; total: number } {
  const live = rows.filter(isLive).length;
  return { live, ended: rows.length - live, total: rows.length };
}
