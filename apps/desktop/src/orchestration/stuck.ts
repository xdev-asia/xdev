import type { MissionTab } from "@/api";

/** Why a tab counts as stuck: busy but silent for too long, or waiting on the person. */
export type StuckReason = "silent" | "waiting";

/** Minutes of silence while busy before a tab is stuck, unless Mission Control is set otherwise. */
export const STUCK_MINUTES_DEFAULT = 10;

type Watched = Pick<MissionTab, "status" | "lastOutputMs" | "exited">;

/**
 * Whether a tab is stuck at `nowMs`: it waits on input (`needs-you`), or it is busy (`working`) and printed nothing
 * for `minutes` minutes. An exited tab, or a busy one that never printed, is not.
 */
export function stuckReason(tab: Watched, nowMs: number, minutes: number = STUCK_MINUTES_DEFAULT): StuckReason | null {
  if (tab.exited) return null;
  if (tab.status === "needs-you") return "waiting";
  if (tab.status !== "working" || tab.lastOutputMs <= 0) return null;
  const quietMs = Math.max(1, minutes) * 60_000;
  return nowMs - tab.lastOutputMs >= quietMs ? "silent" : null;
}

/** The tabs Mission Control lists, stuck first, then workers, then linked tabs, then the other agent tabs; by title within each. */
export function missionOrder<T extends MissionTab>(tabs: readonly T[], linked: ReadonlySet<string>, nowMs: number, minutes: number): T[] {
  const rank = (t: T): number => (stuckReason(t, nowMs, minutes) ? 0 : t.worker ? 1 : linked.has(t.id) ? 2 : 3);
  return tabs
    .filter((t) => t.agent || t.worker || linked.has(t.id))
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r - b.r || (a.t.title ?? a.t.id).localeCompare(b.t.title ?? b.t.id) || a.i - b.i)
    .map((x) => x.t);
}
