import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACTIVITY_OPTIONS_KEY, DEFAULT_ACTIVITY_OPTIONS, loadActivityOptions, saveActivityOptions } from "./options";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("nothing saved gives the defaults", () => {
  expect(loadActivityOptions()).toEqual(DEFAULT_ACTIVITY_OPTIONS);
});

it("saves and loads", () => {
  saveActivityOptions({ showIdle: true, groupByWorktree: true });
  expect(store.has(ACTIVITY_OPTIONS_KEY)).toBe(true);
  expect(loadActivityOptions()).toEqual({ showIdle: true, groupByWorktree: true });
});

it("bad JSON, a wrong shape or wrong field types give the defaults", () => {
  store.set(ACTIVITY_OPTIONS_KEY, "{nope");
  expect(loadActivityOptions()).toEqual(DEFAULT_ACTIVITY_OPTIONS);
  store.set(ACTIVITY_OPTIONS_KEY, "42");
  expect(loadActivityOptions()).toEqual(DEFAULT_ACTIVITY_OPTIONS);
  store.set(ACTIVITY_OPTIONS_KEY, JSON.stringify({ showIdle: "yes", groupByWorktree: true }));
  expect(loadActivityOptions()).toEqual({ showIdle: false, groupByWorktree: true });
});

it("storage that throws is not an error", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("no");
    },
    setItem: () => {
      throw new Error("no");
    },
  });
  expect(loadActivityOptions()).toEqual(DEFAULT_ACTIVITY_OPTIONS);
  expect(() => saveActivityOptions(DEFAULT_ACTIVITY_OPTIONS)).not.toThrow();
});
