import type { Tab } from "./sessions";

/** Statuses of an agent that has stopped working and waits for nobody: safe to put to sleep. */
const RESTING = new Set<string>(["done", "idle"]);

/**
 * The ids of agent tabs to put to sleep: resting, not on screen, and quiet for more than `idleMs`.
 * `lastOutput` is when the tab last wrote (0 or null for never, then its open time counts).
 */
export function dueForSleep(
  tabs: readonly Tab[],
  lastOutput: (id: string) => number | null,
  onScreen: ReadonlySet<string>,
  now: number,
  idleMs: number,
): string[] {
  return tabs
    .filter((tab) => {
      if (!tab.agent || tab.asleep || onScreen.has(tab.id) || !RESTING.has(tab.status)) return false;
      // Without a session it would wake as a new conversation and the old one would be lost.
      if (!(tab.agentSession ?? tab.resumeOf)) return false;
      const last = lastOutput(tab.id) || tab.openedAt;
      return now - last > idleMs;
    })
    .map((tab) => tab.id);
}

export interface AutoSleepLoop {
  tickMs: number;
  /** Read on every tick, so a settings change needs no subscription. */
  settings: () => Promise<{ autoSleep: boolean; sleepAfterMin: number }>;
  /** Read on every tick, so the loop never restarts when the worktrees or the selection change. */
  tabs: () => readonly Tab[];
  onScreen: () => ReadonlySet<string>;
  lastOutput: (id: string) => number | null;
  now: () => number;
  sleep: (id: string) => Promise<unknown>;
}

/** Starts the auto-sleep timer; a tick does not overlap a running one. Returns the stop function. */
export function startAutoSleep(loop: AutoSleepLoop): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const settings = await loop.settings();
        if (!settings.autoSleep) return;
        const due = dueForSleep(loop.tabs(), loop.lastOutput, loop.onScreen(), loop.now(), settings.sleepAfterMin * 60_000);
        for (const id of due) await loop.sleep(id);
      } catch {
        // A failed read or sleep is tried again on the next tick.
      } finally {
        busy = false;
      }
    })();
  }, loop.tickMs);
  return () => clearInterval(timer);
}
