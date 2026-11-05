import { afterEach, expect, it, vi } from "vitest";
import { TIP_KEY, loadTipDismissed, markShown, resetTipForTests, saveTipDismissed, shownThisRun, tipVisible } from "./cliSkillTipModel";

const open = { status: { installed: false }, dismissed: false, shownThisRun: false, suppressed: false };

afterEach(() => {
  vi.unstubAllGlobals();
  resetTipForTests();
});

it("shows when the skill is missing and nothing says otherwise", () => {
  expect(tipVisible(open)).toBe(true);
});

it("does not show before the status is known, or when the skill is installed", () => {
  expect(tipVisible({ ...open, status: null })).toBe(false);
  expect(tipVisible({ ...open, status: { installed: true } })).toBe(false);
});

it("does not show when dismissed, already shown this run, or suppressed", () => {
  expect(tipVisible({ ...open, dismissed: true })).toBe(false);
  expect(tipVisible({ ...open, shownThisRun: true })).toBe(false);
  expect(tipVisible({ ...open, suppressed: true })).toBe(false);
});

it("remembers dismissing in storage", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  expect(loadTipDismissed()).toBe(false);
  saveTipDismissed();
  expect(store.get(TIP_KEY)).toBe("dismissed");
  expect(loadTipDismissed()).toBe(true);
});

it("storage that throws reads as not dismissed and saving does not throw", () => {
  const boom = () => { throw new Error("denied"); };
  vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
  expect(loadTipDismissed()).toBe(false);
  expect(() => saveTipDismissed()).not.toThrow();
});

it("the once per run flag is set by markShown", () => {
  expect(shownThisRun()).toBe(false);
  markShown();
  expect(shownThisRun()).toBe(true);
  resetTipForTests();
  expect(shownThisRun()).toBe(false);
});
