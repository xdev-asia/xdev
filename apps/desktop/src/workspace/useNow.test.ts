import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A hand-driven React: state cells and the effects of the last render, so the hook runs without a DOM.
const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  slot: 0,
  effects: [] as Array<() => void | (() => void)>,
  rerender: () => {},
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (init: unknown) => {
    const at = hooks.slot++;
    if (!(at in hooks.cells)) hooks.cells[at] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (next: unknown) => {
      const value = typeof next === "function" ? (next as (v: unknown) => unknown)(hooks.cells[at]) : next;
      if (Object.is(value, hooks.cells[at])) return;
      hooks.cells[at] = value;
      hooks.rerender();
    };
    return [hooks.cells[at], set];
  },
  useEffect: (fn: () => void | (() => void)) => void hooks.effects.push(fn),
}));

import { useNow } from "./cacheTimer";

const START = new Date("2026-11-04T10:00:00Z").getTime();
let cleanups: Array<() => void> = [];
let latest = 0;

/** One render of `useNow`: the previous effects are cleaned up, the new ones run. */
function mount(active: boolean, step?: number): void {
  const run = () => {
    for (const c of cleanups) c();
    cleanups = [];
    hooks.slot = 0;
    hooks.effects = [];
    latest = useNow(active, step);
    for (const e of hooks.effects) {
      const c = e();
      if (c) cleanups.push(c);
    }
  };
  hooks.rerender = run;
  run();
}

beforeEach(() => {
  hooks.cells = [];
  cleanups = [];
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  for (const c of cleanups) c();
  vi.useRealTimers();
});

it("useNow ticks with the clock every step while active", () => {
  mount(true, 1000);
  expect(latest).toBe(START);
  vi.advanceTimersByTime(1000);
  expect(latest).toBe(START + 1000);
  vi.advanceTimersByTime(2000);
  expect(latest).toBe(START + 3000);
});

it("useNow holds its value while not active and stops ticking once switched off", () => {
  mount(false);
  vi.advanceTimersByTime(5000);
  expect(latest).toBe(START);
  mount(true, 1000);
  vi.advanceTimersByTime(1000);
  expect(latest).toBe(START + 6000);
  mount(false);
  const held = latest;
  vi.advanceTimersByTime(5000);
  expect(latest).toBe(held);
  expect(vi.getTimerCount()).toBe(0);
});
