import { beforeEach, expect, it } from "vitest";
import { ONBOARDING_KEY, parseSaved } from "./onboardingState";
import { closeGuide, finishOnboarding, getOnboarding, openGuide, resetOnboardingForTests, resumeOnboarding, skipOnboarding } from "./onboardingStore";
import { wizardAlone, wizardOver } from "./OnboardingGate";

let data: Map<string, string>;
const storage = () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
beforeEach(() => {
  data = new Map();
  resetOnboardingForTests(storage);
});

it("the gate shows the wizard alone only on a first run", () => {
  expect(wizardAlone(getOnboarding())).toBe(true);
  finishOnboarding({ agent: "claude" });
  expect(wizardAlone(getOnboarding())).toBe(false);
  expect(wizardOver(getOnboarding())).toBe(false);
});

it("a stored done or skipped status keeps the wizard away on the next start", () => {
  for (const status of ["done", "skipped"]) {
    data.set(ONBOARDING_KEY, JSON.stringify({ status, answers: {} }));
    resetOnboardingForTests(storage);
    expect(getOnboarding().wizardOpen).toBe(false);
    expect(wizardAlone(getOnboarding())).toBe(false);
  }
});

it("Finish stores done with the answers", () => {
  finishOnboarding({ theme: "dark", language: "vi" });
  expect(parseSaved(data.get(ONBOARDING_KEY))).toEqual({ status: "done", answers: { theme: "dark", language: "vi" } });
});

it("a confirmed skip stores skipped, not done, and continues to the app", () => {
  skipOnboarding();
  expect(parseSaved(data.get(ONBOARDING_KEY)).status).toBe("skipped");
  expect(getOnboarding().wizardOpen).toBe(false);
});

it("Resume setup reopens the wizard over the app and closes the guide", () => {
  skipOnboarding();
  openGuide();
  expect(getOnboarding().guideOpen).toBe(true);
  resumeOnboarding();
  expect(wizardOver(getOnboarding())).toBe(true);
  expect(getOnboarding().guideOpen).toBe(false);
  closeGuide();
});

it("keeps going in memory when storage throws", () => {
  resetOnboardingForTests(() => {
    throw new Error("blocked");
  });
  expect(wizardAlone(getOnboarding())).toBe(true);
  skipOnboarding();
  expect(wizardAlone(getOnboarding())).toBe(false);
});
