import { api } from "./api";
import { OnboardingGate } from "./onboarding/OnboardingGate";
import { WorkspaceShell } from "./workspace/WorkspaceShell";

/** The whole app: the workspace shell, which hosts the docs app as one of its views, behind the first-run wizard. */
export function App() {
  return (
    <OnboardingGate api={api}>
      <WorkspaceShell api={api} />
    </OnboardingGate>
  );
}
