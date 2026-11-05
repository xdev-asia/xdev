import type { Check } from "../api";

/** The first wait and the floor of every wait, in ms. */
export const POLL_BASE_MS = 60_000;
/** The longest wait while checks do not change. */
export const POLL_IDLE_MAX_MS = 120_000;
/** The longest wait while reads fail. */
export const POLL_ERROR_MAX_MS = 15 * 60_000;

export type PollOutcome = "changed" | "same" | "error";

/** Polls only while both the panel and the window are visible. */
export function shouldPoll(v: {
  panelVisible: boolean;
  windowVisible: boolean;
}): boolean {
  return v.panelVisible && v.windowVisible;
}

/**
 * The wait before the next read. A change resets to 60 s, an unchanged read
 * backs off to 120 s and a failed one doubles up to 15 min.
 */
export function nextDelay(current: number, outcome: PollOutcome): number {
  if (outcome === "changed") return POLL_BASE_MS;
  const base = Math.max(current, POLL_BASE_MS);
  if (outcome === "same") return POLL_IDLE_MAX_MS;
  return Math.min(POLL_ERROR_MAX_MS, base * 2);
}

export type TriageKind =
  "failing" | "cancelled" | "pending" | "unresolved" | "none";

export interface Triage {
  kind: TriageKind;
  count: number;
}

/** What the strip above the checks says. The first kind that has a check wins. */
export function triage(checks: readonly Check[]): Triage {
  const n = (b: Check["bucket"]) => checks.filter((c) => c.bucket === b).length;
  if (n("fail") > 0) return { kind: "failing", count: n("fail") };
  if (n("cancel") > 0) return { kind: "cancelled", count: n("cancel") };
  if (n("pending") > 0) return { kind: "pending", count: n("pending") };
  if (n("skipping") > 0 && n("pass") === 0)
    return { kind: "unresolved", count: n("skipping") };
  return { kind: "none", count: 0 };
}

/** The checks "Fix" hands to an agent. */
export function failingChecks(checks: readonly Check[]): Check[] {
  return checks.filter((c) => c.bucket === "fail");
}

/** "Rerun unsuccessful" is enabled when a check failed or was cancelled. */
export function canRerunUnsuccessful(checks: readonly Check[]): boolean {
  return checks.some((c) => c.bucket === "fail" || c.bucket === "cancel");
}
