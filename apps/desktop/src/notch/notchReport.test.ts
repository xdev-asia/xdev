import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Sessions, Tab } from "@/workspace/sessions";
import { NOTCH_THROTTLE_MS, notchTabs, startNotchReport } from "./notchReport";

const t = (key: string) => (key === "terminal.profile.claude" ? "Claude" : key);

function store(tabs: Partial<Tab>[]) {
  let all = tabs.map((x) => ({ agent: true, status: "idle", worktree: "/w", profileId: "claude", title: null, renamed: false, ...x }) as Tab);
  const listeners = new Set<() => void>();
  const sessions = {
    worktrees: () => [...new Set(all.map((x) => x.worktree))],
    tabs: (w: string) => all.filter((x) => x.worktree === w),
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as Pick<Sessions, "worktrees" | "tabs" | "subscribe">;
  const set = (next: Partial<Tab>[]) => {
    all = next.map((x) => ({ agent: true, status: "idle", worktree: "/w", profileId: "claude", title: null, renamed: false, ...x }) as Tab);
    for (const l of [...listeners]) l();
  };
  return { sessions, set, listeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("lists agent tabs only, named by hand or by profile and never by the prompt", () => {
  const { sessions } = store([
    { id: "a", status: "working", title: "Fix the login bug", autoTitled: true },
    { id: "b", status: "needs-you", title: "Reviewer", renamed: true, worktree: "/v" },
    { id: "c", agent: false, status: "working" },
  ]);
  expect(notchTabs(sessions, t)).toEqual([
    { ptyId: "a", status: "working", name: "Claude", worktree: "/w" },
    { ptyId: "b", status: "needs-you", name: "Reviewer", worktree: "/v" },
  ]);
});

it("sends at start, gathers changes, and skips an unchanged list", async () => {
  const h = store([{ id: "a", status: "working" }]);
  const notchReport = vi.fn(async () => {});
  const stop = startNotchReport({ notchReport }, h.sessions, t);
  expect(notchReport).toHaveBeenCalledTimes(1);
  h.set([{ id: "a", status: "needs-you" }]);
  h.set([{ id: "a", status: "needs-you" }]);
  expect(notchReport).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(NOTCH_THROTTLE_MS);
  expect(notchReport).toHaveBeenCalledTimes(2);
  expect(notchReport).toHaveBeenLastCalledWith([{ ptyId: "a", status: "needs-you", name: "Claude", worktree: "/w" }]);
  h.set([{ id: "a", status: "needs-you" }]);
  vi.advanceTimersByTime(NOTCH_THROTTLE_MS);
  expect(notchReport).toHaveBeenCalledTimes(2);
  stop();
  expect(h.listeners.size).toBe(0);
});

it("sends again after a failed call", async () => {
  const h = store([{ id: "a", status: "working" }]);
  const notchReport = vi.fn().mockRejectedValueOnce({ code: "io" }).mockResolvedValue(undefined);
  startNotchReport({ notchReport }, h.sessions, t);
  await vi.runAllTimersAsync();
  h.set([{ id: "a", status: "working" }]);
  vi.advanceTimersByTime(NOTCH_THROTTLE_MS);
  expect(notchReport).toHaveBeenCalledTimes(2);
});
