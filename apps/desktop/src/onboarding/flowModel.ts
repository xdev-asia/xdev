import type { Api } from "@/api";
import type { Answers } from "./onboardingState";

/** The wizard's steps in order. */
export const STEPS = ["agent", "look", "language", "notifications"] as const;
export type Step = (typeof STEPS)[number];

export type FlowState = { step: number; answers: Answers; asking: boolean };

export type FlowAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "answer"; answers: Answers }
  | { type: "askSkip" }
  | { type: "cancelSkip" };

export const initialFlow = (answers: Answers = {}): FlowState => ({ step: 0, answers, asking: false });

export const isFirstStep = (s: FlowState): boolean => s.step === 0;
export const isLastStep = (s: FlowState): boolean => s.step === STEPS.length - 1;

export function flowReducer(s: FlowState, a: FlowAction): FlowState {
  switch (a.type) {
    case "next":
      return isLastStep(s) ? s : { ...s, step: s.step + 1 };
    case "back":
      return isFirstStep(s) ? s : { ...s, step: s.step - 1 };
    case "answer":
      return { ...s, answers: { ...s.answers, ...a.answers } };
    case "askSkip":
      return { ...s, asking: true };
    case "cancelSkip":
      return { ...s, asking: false };
  }
}

/**
 * Finish: the default agent and shell go through `profilesDefaults`, the theme through
 * `uiSettingsPut` (over a fresh read, so other view settings stay as they are). A step that was
 * not answered changes nothing.
 */
export async function saveAnswers(api: Pick<Api, "profiles" | "profilesDefaults" | "uiSettingsGet" | "uiSettingsPut">, answers: Answers): Promise<void> {
  if (answers.agent !== undefined || answers.shell !== undefined) {
    const view = await api.profiles();
    await api.profilesDefaults(view.approvals, answers.agent ?? view.defaultAgent, answers.shell ?? view.defaultShell);
  }
  if (answers.theme !== undefined) {
    const ui = await api.uiSettingsGet();
    if (ui.theme !== answers.theme) await api.uiSettingsPut({ ...ui, theme: answers.theme });
  }
}

/** Asks the OS for notifications with one OS notification; the first one makes the OS ask. */
export async function allowNotifications(api: Pick<Api, "notifyUpdate">, title: string, body: string): Promise<"allowed" | "denied"> {
  try {
    await api.notifyUpdate(title, body);
    return "allowed";
  } catch {
    return "denied";
  }
}
