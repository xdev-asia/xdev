import { beforeEach, expect, it, vi } from "vitest";
import { CHIP_PREFS_KEY, chipPrefs, parsePrefs, resetChipPrefs, setChip } from "./chipPrefs";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  resetChipPrefs();
});

it("every chip is on until it is turned off", () => {
  expect(chipPrefs()).toEqual({ quota: true, context: true, timer: true });
  expect(parsePrefs("{ nope")).toEqual({ quota: true, context: true, timer: true });
  expect(parsePrefs('{"timer":false,"quota":"x"}')).toEqual({ quota: true, context: true, timer: false });
  expect(parsePrefs("null")).toEqual({ quota: true, context: true, timer: true });
});

it("a switch is kept in storage and read back", () => {
  setChip("context", false);
  expect(chipPrefs().context).toBe(false);
  expect(JSON.parse(store.get(CHIP_PREFS_KEY)!)).toEqual({ quota: true, context: false, timer: true });
  resetChipPrefs();
  expect(chipPrefs()).toEqual({ quota: true, context: false, timer: true });
  setChip("context", true);
  expect(chipPrefs().context).toBe(true);
});
