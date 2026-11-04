import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { advanceTimers, cacheLeftMs, formatCacheLeft, NO_TIMERS, type TimerState } from "./cacheTimer";
import type { Tab } from "./sessions";
import { TabStrip } from "./TabStrip";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const MIN = 60_000;
const tab = (id: string, status: string, over: Partial<Tab> = {}): Tab =>
  ({ id, agent: true, cli: "claude", status, profileId: "claude", worktree: "/w", account: null, permissions: "ask", unread: false, title: null, renamed: false, pinned: false, color: "none", ...over }) as unknown as Tab;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("cacheLeftMs counts down from the settle time and stops at 0", () => {
  expect(cacheLeftMs(1000, 1000, 5 * MIN)).toBe(5 * MIN);
  expect(cacheLeftMs(1000, 1000 + 2 * MIN, 5 * MIN)).toBe(3 * MIN);
  expect(cacheLeftMs(1000, 1000 + 5 * MIN, 5 * MIN)).toBe(0);
  expect(cacheLeftMs(1000, 1000 + 99 * MIN, 5 * MIN)).toBe(0);
  expect(formatCacheLeft(5 * MIN)).toBe("5:00");
  expect(formatCacheLeft(4 * MIN + 59_001)).toBe("5:00");
  expect(formatCacheLeft(61_000)).toBe("1:01");
  expect(formatCacheLeft(60 * MIN)).toBe("60:00");
});

it("the first look with the switch on seeds every settled Claude tab with now", () => {
  const s = advanceTimers(NO_TIMERS, [tab("a", "done"), tab("b", "idle"), tab("c", "working"), tab("x", "exited")], true, 1000);
  expect([...s.settled]).toEqual([["a", 1000], ["b", 1000]]);
});

it("a codex tab and a plain shell get no timer", () => {
  const s = advanceTimers(NO_TIMERS, [tab("cx", "done", { cli: "codex" }), tab("sh", "idle", { agent: false, cli: null })], true, 1000);
  expect(s.settled.size).toBe(0);
});

it("working to done starts the timer, working again clears it, exited clears it", () => {
  let s: TimerState = advanceTimers(NO_TIMERS, [tab("a", "working")], true, 0);
  expect(s.settled.size).toBe(0);
  s = advanceTimers(s, [tab("a", "done")], true, 10_000);
  expect(s.settled.get("a")).toBe(10_000);
  // Still done later: the start does not move.
  s = advanceTimers(s, [tab("a", "done", { unread: true })], true, 20_000);
  expect(s.settled.get("a")).toBe(10_000);
  s = advanceTimers(s, [tab("a", "working")], true, 30_000);
  expect(s.settled.has("a")).toBe(false);
  s = advanceTimers(s, [tab("a", "needs-you")], true, 31_000);
  s = advanceTimers(s, [tab("a", "idle")], true, 40_000);
  expect(s.settled.get("a")).toBe(40_000);
  s = advanceTimers(s, [tab("a", "exited")], true, 50_000);
  expect(s.settled.has("a")).toBe(false);
});

it("a tab opened later that never worked has no timer", () => {
  let s = advanceTimers(NO_TIMERS, [], true, 0);
  s = advanceTimers(s, [tab("n", "idle")], true, 5000);
  expect(s.settled.size).toBe(0);
});

it("nothing changed returns the same state, and switching off clears everything", () => {
  const tabs = [tab("a", "done")];
  const s = advanceTimers(NO_TIMERS, tabs, true, 1000);
  expect(advanceTimers(s, tabs, true, 9999)).toBe(s);
  expect(advanceTimers(s, tabs, false, 9999)).toBe(NO_TIMERS);
  // Switching on again seeds with the time of that look.
  expect(advanceTimers(NO_TIMERS, tabs, true, 7000).settled.get("a")).toBe(7000);
});

// --- the strip draws it ---

function strip(tabs: Tab[], cache?: { timers: ReadonlyMap<string, number>; ttlMs: number }) {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(TabStrip, {
      pane: "p", items: tabs.map((t) => ({ id: t.id, tab: t })), active: tabs[0]?.id ?? null, groups: [], menuOpen: false, cache,
      onSelect: noop, onClose: noop, onCloseOthers: noop, onCloseToRight: noop, onLaunch: noop, onSplit: noop, onMoveToSplit: noop,
      onPin: noop, onCopyTabId: noop, onChangeTitle: noop, onColor: noop, onRename: noop, onMenu: noop,
    }),
  );
}

it("a settled tab shows 5:00, then 0:00 becomes the cold mark", () => {
  const tabs = [tab("a", "done")];
  const timers = new Map([["a", Date.now()]]);
  const cache = { timers, ttlMs: 5 * MIN };
  expect(strip(tabs, cache)).toContain(">5:00<");
  expect(strip(tabs, cache)).toContain("ws-tab-cache");
  vi.advanceTimersByTime(MIN + 30_000);
  expect(strip(tabs, cache)).toContain(">3:30<");
  vi.advanceTimersByTime(3 * MIN + 30_000);
  const cold = strip(tabs, cache);
  expect(cold).toContain("ws-tab-cache-cold");
  expect(cold).toContain(en("usage.cacheTimer.cold"));
  expect(cold).toContain(en("usage.cacheTimer.coldTitle"));
  expect(cold).not.toContain(">0:00<");
});

it("with the switch off, or no timer for the tab, nothing is drawn", () => {
  const tabs = [tab("a", "done")];
  expect(strip(tabs)).not.toContain("ws-tab-cache");
  expect(strip(tabs, { timers: new Map(), ttlMs: 5 * MIN })).not.toContain("ws-tab-cache");
});
