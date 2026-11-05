import { afterEach, expect, it, vi } from "vitest";
import { startAutoSleep } from "./autoSleep";
import type { Tab } from "./sessions";

const MIN = 60_000;
const old = (id: string) => ({ id, worktree: "/w", agent: true, status: "done", openedAt: 0, agentSession: "s", resumeOf: null }) as unknown as Tab;

afterEach(() => vi.useRealTimers());

it("ticks on a steady 60 s beat while the inputs change, and sleeps what is due", async () => {
  vi.useFakeTimers();
  let tabs: Tab[] = [];
  const sleep = vi.fn(async () => {});
  const settings = vi.fn(async () => ({ autoSleep: true, sleepAfterMin: 30 }));
  const stop = startAutoSleep({ tickMs: MIN, settings, tabs: () => tabs, onScreen: () => new Set(), lastOutput: () => 1, now: () => 100 * MIN, sleep });
  // The selection changes every 40 s; a loop restarted by it would never tick.
  for (let i = 0; i < 3; i++) {
    tabs = [old(`t${i}`)];
    await vi.advanceTimersByTimeAsync(40_000);
  }
  expect(settings).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith("t1");
  stop();
  await vi.advanceTimersByTimeAsync(5 * MIN);
  expect(settings).toHaveBeenCalledTimes(2);
});

it("does nothing while auto sleep is off and does not overlap a running tick", async () => {
  vi.useFakeTimers();
  const sleep = vi.fn(async () => {});
  let release: () => void = () => {};
  const settings = vi.fn(() => new Promise<{ autoSleep: boolean; sleepAfterMin: number }>((r) => (release = () => r({ autoSleep: false, sleepAfterMin: 30 }))));
  const stop = startAutoSleep({ tickMs: MIN, settings, tabs: () => [old("a")], onScreen: () => new Set(), lastOutput: () => 1, now: () => 100 * MIN, sleep });
  await vi.advanceTimersByTimeAsync(3 * MIN);
  expect(settings).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(MIN);
  expect(sleep).not.toHaveBeenCalled();
  stop();
});
