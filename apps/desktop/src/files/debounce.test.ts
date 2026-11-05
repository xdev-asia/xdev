import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Effect = { fn: () => void | (() => void); deps: unknown[] };
const rt = vi.hoisted(() => ({ value: undefined as unknown, effects: [] as Effect[] }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    if (rt.value === undefined) rt.value = initial;
    return [rt.value, (v: unknown) => void (rt.value = v)];
  },
  useEffect: (fn: Effect["fn"], deps: unknown[]) => void rt.effects.push({ fn, deps }),
}));
const { useDebounced } = await import("./debounce");

/** One render; like React, the effect reruns (after its cleanup) only when its deps changed. */
let last: { deps: unknown[]; cleanup: void | (() => void) } | null = null;
function render(value: string, ms: number, paused = false): string {
  rt.effects = [];
  const out = useDebounced(value, ms, paused);
  const { fn, deps } = rt.effects[0];
  if (!last || deps.some((d, i) => !Object.is(d, last!.deps[i]))) {
    if (last && typeof last.cleanup === "function") last.cleanup();
    last = { deps, cleanup: fn() };
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  rt.value = undefined;
  last = null;
});
afterEach(() => vi.useRealTimers());

it("holds the old value until the text has been quiet for the delay, then takes the last one", () => {
  expect(render("a", 200)).toBe("a");
  render("ab", 200);
  vi.advanceTimersByTime(150);
  render("abc", 200);
  vi.advanceTimersByTime(150);
  expect(render("abc", 200)).toBe("a");
  vi.advanceTimersByTime(60);
  expect(render("abc", 200)).toBe("abc");
});

it("takes the value at once when the delay is 0", () => {
  render("a", 0);
  render("b", 0);
  expect(render("b", 0)).toBe("b");
});

it("does not move while paused, and catches up when resumed", () => {
  render("a", 200);
  render("b", 200, true);
  vi.advanceTimersByTime(1000);
  expect(render("b", 200, true)).toBe("a");
  render("b", 200, false);
  vi.advanceTimersByTime(200);
  expect(render("b", 200, false)).toBe("b");
});
