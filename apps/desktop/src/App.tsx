import { api } from "./api";
import { OnboardingGate } from "./onboarding/OnboardingGate";
import { useOnboarding } from "./onboarding/onboardingStore";
import { CliSkillTip } from "./shell/CliSkillTip";
import { WorkspaceShell } from "./workspace/WorkspaceShell";

/** The whole app: the workspace shell, which hosts the docs app as one of its views, behind the first-run wizard. */
export function App() {
  const { wizardOpen } = useOnboarding();
  return (
    <>
      <OnboardingGate api={api}>
        <WorkspaceShell api={api} />
      </OnboardingGate>
      <CliSkillTip api={api} suppressed={wizardOpen} />
    </>
  );
}
