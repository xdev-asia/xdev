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
      const last = lastOutput(tab.id) || tab.openedAt;
      return now - last > idleMs;
    })
    .map((tab) => tab.id);
}
