import { expect, it } from "vitest";
import type { Accounts, Quota } from "@/api";
import { advanceRuns, contextPercent, formatElapsed, formatTokens, runElapsed, tabAccount, tabQuota, type RunClocks } from "./chipModel";

it("formats elapsed time as m:ss, then h:mm:ss, never negative", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(999)).toBe("0:00");
  expect(formatElapsed(65_000)).toBe("1:05");
  expect(formatElapsed(3_600_000 + 61_000)).toBe("1:01:01");
  expect(formatElapsed(-5000)).toBe("0:00");
});

it("formats tokens short", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(1234)).toBe("1.2k");
  expect(formatTokens(45_005)).toBe("45k");
  expect(formatTokens(1_250_000)).toBe("1.3M");
});

it("the context percent is whole, capped, and null for a window that is not usable", () => {
  expect(contextPercent(45_000, 200_000)).toBe(23);
  expect(contextPercent(250_000, 200_000)).toBe(100);
  expect(contextPercent(10, 0)).toBeNull();
  expect(contextPercent(Number.NaN, 100)).toBeNull();
  expect(contextPercent(-1, 100)).toBeNull();
});

const accounts: Accounts = {
  reservePercent: 30,
  accounts: [],
  active: [{ provider: "claude", name: "claude-2" }, { provider: "codex", name: "codex-1" }],
};
const quota: Quota[] = [
  { name: "claude-2", state: "ok", reason: null, windows: [{ key: "five_hour", utilization: 12.4, resetsAt: null }, { key: "seven_day", utilization: 40, resetsAt: null }], asOf: null },
  { name: "claude-3", state: "ok", reason: null, windows: [{ key: "five_hour", utilization: null, resetsAt: null }], asOf: null },
  { name: "old", state: "unknown", reason: "logged_out", windows: [], asOf: null },
];

it("a tab's account is its accountId, then the account it runs under, then the provider's active one", () => {
  expect(tabAccount({ accountId: "a", account: "b", cli: "claude" }, accounts)).toBe("a");
  expect(tabAccount({ account: "b", cli: "claude" }, accounts)).toBe("b");
  expect(tabAccount({ account: null, cli: "claude" }, accounts)).toBe("claude-2");
  expect(tabAccount({ account: null, cli: "codex" }, accounts)).toBe("codex-1");
  expect(tabAccount({ account: null, cli: null }, accounts)).toBeNull();
  expect(tabAccount({ account: null, cli: "claude" }, null)).toBeNull();
});

it("the quota of an account has its two windows, each null when unknown, and nothing when none is known", () => {
  expect(tabQuota(quota, "claude-2")).toEqual({ account: "claude-2", fiveHour: 12, weekly: 40 });
  expect(tabQuota(quota, "claude-3")).toBeNull();
  expect(tabQuota(quota, "old")).toBeNull();
  expect(tabQuota(quota, "nobody")).toBeNull();
  expect(tabQuota(null, "claude-2")).toBeNull();
  expect(tabQuota(quota, null)).toBeNull();
  expect(tabQuota([{ ...quota[0], windows: [quota[0].windows[1]] }], "claude-2")).toEqual({ account: "claude-2", fiveHour: null, weekly: 40 });
});

const tab = (status: "working" | "idle" | "done" | "needs-you" | "exited", agent = true) => [{ id: "t1", agent, status }];

it("a clock starts when a tab turns working and stops when it leaves it", () => {
  const none: RunClocks = new Map();
  const running = advanceRuns(none, tab("working"), 1000);
  expect(running.get("t1")).toEqual({ since: 1000, endedAt: null });
  // Still working: the same map, the same start.
  expect(advanceRuns(running, tab("working"), 5000)).toBe(running);
  const stopped = advanceRuns(running, tab("idle"), 9000);
  expect(stopped.get("t1")).toEqual({ since: 1000, endedAt: 9000 });
  expect(runElapsed(stopped.get("t1")!, 99_000)).toBe(8000);
  // Idle again: nothing moves.
  expect(advanceRuns(stopped, tab("done"), 12_000)).toBe(stopped);
  // Working again starts a new run.
  expect(advanceRuns(stopped, tab("working"), 20_000).get("t1")).toEqual({ since: 20_000, endedAt: null });
});

it("needs-you and exit stop a clock; a shell and a tab never seen working get none", () => {
  const running = advanceRuns(new Map(), tab("working"), 0);
  expect(advanceRuns(running, tab("needs-you"), 3000).get("t1")?.endedAt).toBe(3000);
  expect(advanceRuns(running, tab("exited"), 4000).get("t1")?.endedAt).toBe(4000);
  expect(advanceRuns(new Map(), tab("working", false), 0).size).toBe(0);
  const idle = new Map();
  expect(advanceRuns(idle, tab("idle"), 0)).toBe(idle);
});

it("a running clock grows with now and never goes below zero", () => {
  expect(runElapsed({ since: 1000, endedAt: null }, 4500)).toBe(3500);
  expect(runElapsed({ since: 5000, endedAt: null }, 1000)).toBe(0);
});
