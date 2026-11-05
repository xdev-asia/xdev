import { expect, it } from "vitest";
import { EMPTY_SAVED, ONBOARDING_KEY, isFirstRun, loadSaved, parseSaved, writeSaved } from "./onboardingState";

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

it("is a first run when nothing is stored", () => {
  expect(loadSaved(() => memory())).toEqual(EMPTY_SAVED);
  expect(isFirstRun(EMPTY_SAVED)).toBe(true);
});

it("round-trips status and answers under the v1 key", () => {
  const m = memory();
  expect(writeSaved({ status: "done", answers: { agent: "claude", theme: "dark", language: "vi", notifications: "allowed" } }, () => m)).toBe(true);
  expect(ONBOARDING_KEY).toBe("xdev.onboarding.v1");
  expect(m.data.has(ONBOARDING_KEY)).toBe(true);
  expect(loadSaved(() => m)).toEqual({ status: "done", answers: { agent: "claude", theme: "dark", language: "vi", notifications: "allowed" } });
});

it("treats bad JSON and bad fields as a first run with no answers", () => {
  expect(parseSaved("{nope")).toEqual(EMPTY_SAVED);
  expect(parseSaved("42")).toEqual(EMPTY_SAVED);
  expect(parseSaved(JSON.stringify({ status: "later", answers: { theme: "pink", language: "fr", agent: 3 } }))).toEqual(EMPTY_SAVED);
});

it("survives a storage that throws", () => {
  const broken = () => {
    throw new Error("blocked");
  };
  expect(loadSaved(broken)).toEqual(EMPTY_SAVED);
  expect(writeSaved(EMPTY_SAVED, broken)).toBe(false);
  expect(loadSaved(() => ({ getItem: broken, setItem: broken }))).toEqual(EMPTY_SAVED);
});
