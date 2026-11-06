import type { JSX, ReactNode } from "react";
import type { Api } from "@/api";
import { OnboardingFlow } from "./OnboardingFlow";
import { finishOnboarding, skipOnboarding, useOnboarding, type OnboardingState } from "./onboardingStore";
import { isFirstRun } from "./onboardingState";
import { SetupGuide } from "./SetupGuide";
import { Tour } from "./Tour";

/** The wizard shows alone on a first run (neither done nor skipped), and over the app when resumed. */
export const wizardAlone = (s: OnboardingState): boolean => s.wizardOpen && isFirstRun(s.saved);
export const wizardOver = (s: OnboardingState): boolean => s.wizardOpen && !isFirstRun(s.saved);

/** Gates the app on first run; from App.tsx. */
export function OnboardingGate(props: { api: Api; children: ReactNode }): JSX.Element {
  const state = useOnboarding();
  const flow = (
    <OnboardingFlow api={props.api} answers={state.saved.answers} onFinish={finishOnboarding} onSkip={skipOnboarding} />
  );
  if (wizardAlone(state)) return flow;
  return (
    <>
      {props.children}
      {wizardOver(state) && <div className="onb-over">{flow}</div>}
      <SetupGuide api={props.api} />
      <Tour api={props.api} />
    </>
  );
}
