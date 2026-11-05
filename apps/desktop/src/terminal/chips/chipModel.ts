import type { Accounts, Quota } from "@/api";
import type { TabStatus } from "@/workspace/status";

/** `m:ss`, or `h:mm:ss` from an hour; never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** `950`, `12.3k`, `1.2M`: short enough for a chip. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

/** Whole percent of the window in use, 0-100; null when the window is not a positive number. */
export function contextPercent(tokens: number, window: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens < 0) return null;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** The context chip turns to a warning at this percent. */
export const CONTEXT_WARN = 80;

/** What a tab's quota chip shows: percent used in the two windows, null where the window is unknown. */
export interface TabQuota {
  account: string;
  fiveHour: number | null;
  weekly: number | null;
}

/**
 * The account a tab's agent runs as: the `accountId` the session carries (a lane adds it), else the
 * account the tab started under, else the provider's active account.
 */
export function tabAccount(tab: { account?: string | null; accountId?: string | null; cli: string | null }, accounts: Accounts | null): string | null {
  return tab.accountId ?? tab.account ?? (tab.cli ? (accounts?.active.find((a) => a.provider === tab.cli)?.name ?? null) : null);
}

/** The 5-hour and weekly use of `account`; null when quota is unread, the account unknown, or no window is known. */
export function tabQuota(quota: readonly Quota[] | null, account: string | null): TabQuota | null {
  if (!quota || !account) return null;
  const q = quota.find((x) => x.name === account);
  if (!q) return null;
  const pct = (key: string): number | null => {
    const u = q.windows.find((w) => w.key === key)?.utilization;
    return u === null || u === undefined ? null : Math.round(u);
  };
  const fiveHour = pct("five_hour");
  const weekly = pct("seven_day");
  return fiveHour === null && weekly === null ? null : { account, fiveHour, weekly };
}

/** When an agent tab last became busy, and when it stopped being so; both ms. */
export interface RunClock {
  since: number;
  /** null while it is still working. */
  endedAt: number | null;
}

export type RunClocks = ReadonlyMap<string, RunClock>;

/**
 * The clocks after a look at `tabs` at `now`. A tab that turns `working` starts a clock; one that leaves
 * `working` (done, idle, needs you, failed, exited) stops it and keeps its length. Returns `prev` itself when
 * nothing changed. [Inference] "Busy" is the tab's `working` status as the UI sees it, not a time read from the
 * agent log, so a tab already working when its clock is first seen starts from that look.
 */
export function advanceRuns(prev: RunClocks, tabs: readonly { id: string; agent: boolean; status: TabStatus }[], now: number): RunClocks {
  let next: Map<string, RunClock> | null = null;
  const set = (id: string, clock: RunClock) => {
    next ??= new Map(prev);
    next.set(id, clock);
  };
  for (const tab of tabs) {
    if (!tab.agent) continue;
    const clock = prev.get(tab.id);
    if (tab.status === "working") {
      if (!clock || clock.endedAt !== null) set(tab.id, { since: now, endedAt: null });
    } else if (clock && clock.endedAt === null) {
      set(tab.id, { since: clock.since, endedAt: now });
    }
  }
  return next ?? prev;
}

/** Elapsed ms of a clock at `now`: running clocks grow, stopped ones keep their length. */
export function runElapsed(clock: RunClock, now: number): number {
  return Math.max(0, (clock.endedAt ?? now) - clock.since);
}
