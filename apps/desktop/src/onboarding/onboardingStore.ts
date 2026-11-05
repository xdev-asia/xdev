import { useSyncExternalStore } from "react";
import { EMPTY_SAVED, isFirstRun, loadSaved, writeSaved, type Answers, type Saved } from "./onboardingState";

/** The wizard's outcome plus which onboarding surfaces are open right now. */
export type OnboardingState = { saved: Saved; wizardOpen: boolean; guideOpen: boolean };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

let storage: (() => Storage | undefined) | undefined;
let state: OnboardingState | null = null;
const listeners = new Set<() => void>();

function current(): OnboardingState {
  if (!state) {
    const saved = loadSaved(storage);
    state = { saved, wizardOpen: isFirstRun(saved), guideOpen: false };
  }
  return state;
}

function set(next: OnboardingState): void {
  state = next;
  for (const l of [...listeners]) l();
}

export const getOnboarding = (): OnboardingState => current();

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(subscribeOnboarding, getOnboarding, getOnboarding);
}

/** Finishing the wizard: the answers are kept and onboarding counts as done. */
export function finishOnboarding(answers: Answers): void {
  const saved: Saved = { status: "done", answers: { ...current().saved.answers, ...answers } };
  writeSaved(saved, storage);
  set({ ...current(), saved, wizardOpen: false });
}

/** Skipping: onboarding is not done, so the setup guide keeps offering it. */
export function skipOnboarding(): void {
  const saved: Saved = { status: "skipped", answers: current().saved.answers };
  writeSaved(saved, storage);
  set({ ...current(), saved, wizardOpen: false });
}

/** "Resume setup": the wizard opens over the app and the guide closes. */
export function resumeOnboarding(): void {
  set({ ...current(), wizardOpen: true, guideOpen: false });
}

/** Closes the wizard without a verdict (Back out of a resumed run). */
export function closeWizard(): void {
  set({ ...current(), wizardOpen: false });
}

export function openGuide(): void {
  set({ ...current(), guideOpen: true });
}

export function closeGuide(): void {
  set({ ...current(), guideOpen: false });
}

/** Tests: a fresh store reading `next` storage. */
export function resetOnboardingForTests(next?: () => Storage | undefined): void {
  storage = next;
  state = null;
  listeners.clear();
  if (!next) state = { saved: EMPTY_SAVED, wizardOpen: true, guideOpen: false };
}
