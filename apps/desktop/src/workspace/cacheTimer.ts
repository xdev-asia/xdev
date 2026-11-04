import { useEffect, useState } from "react";
import type { Tab } from "./sessions";
import type { TabStatus } from "./status";

/** Milliseconds of prompt cache left: `ttlMs` after `settledAt`, never below 0 and never above `ttlMs`. */
export function cacheLeftMs(settledAt: number, now: number, ttlMs: number): number {
  return Math.min(ttlMs, Math.max(0, settledAt + ttlMs - now));
}

/** `m:ss`; minutes may pass 59 for the one-hour lifetime. */
export function formatCacheLeft(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface TimerState {
  /** Tab id → when it settled (done or idle), in ms. */
  settled: ReadonlyMap<string, number>;
  /** Each Claude tab's status at the last look, to see transitions. */
  seen: ReadonlyMap<string, TabStatus>;
  /** Whether the switch-on (or first) pass has run. */
  seeded: boolean;
}

export const NO_TIMERS: TimerState = { settled: new Map(), seen: new Map(), seeded: false };

const SETTLED: ReadonlySet<TabStatus> = new Set(["done", "idle"]);
const isClaude = (tab: Tab) => tab.agent && tab.cli === "claude";

/**
 * The next state after a look at `tabs` at `now`. The first look with the switch on seeds every
 * settled Claude tab with `now`; later a tab starts its timer when its status moves from something
 * else to done or idle. Working again, or exited, clears it. [Inference] This is the transition the UI
 * sees, not a time read from the agent log. Returns `prev` itself when nothing changed.
 */
export function advanceTimers(prev: TimerState, tabs: readonly Tab[], on: boolean, now: number): TimerState {
  if (!on) return prev.seeded || prev.settled.size > 0 ? NO_TIMERS : prev;
  const settled = new Map<string, number>();
  const seen = new Map<string, TabStatus>();
  for (const tab of tabs) {
    if (!isClaude(tab)) continue;
    seen.set(tab.id, tab.status);
    const before = prev.settled.get(tab.id);
    if (tab.status === "working" || tab.status === "exited") continue;
    if (before !== undefined) {
      settled.set(tab.id, before);
      continue;
    }
    if (!SETTLED.has(tab.status)) continue;
    const was = prev.seen.get(tab.id);
    if (!prev.seeded || (was !== undefined && !SETTLED.has(was))) settled.set(tab.id, now);
  }
  const same =
    prev.seeded &&
    settled.size === prev.settled.size &&
    [...settled].every(([id, at]) => prev.settled.get(id) === at) &&
    seen.size === prev.seen.size &&
    [...seen].every(([id, s]) => prev.seen.get(id) === s);
  return same ? prev : { settled, seen, seeded: true };
}

/** Tab id → when it settled, for the Claude tabs of `tabs`, while the switch is on. */
export function useCacheTimers(tabs: readonly Tab[], on: boolean): ReadonlyMap<string, number> {
  const [state, setState] = useState<TimerState>(NO_TIMERS);
  useEffect(() => {
    setState((prev) => advanceTimers(prev, tabs, on, Date.now()));
  }, [tabs, on]);
  return state.settled;
}

/** `Date.now()`, again every `stepMs` while `active`. */
export function useNow(active: boolean, stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [active, stepMs]);
  return now;
}
