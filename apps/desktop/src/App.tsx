import { api } from "./api";
import { OnboardingGate } from "./onboarding/OnboardingGate";
import { useOnboarding } from "./onboarding/onboardingStore";
import { FeatureWallHost } from "./featureWall/FeatureWall";
import { LinksChoiceHost } from "./browser/LinksChoiceDialog";
import { TipsHost } from "./tips/TipsModal";
import { LspHost } from "./files/lsp/LspHost";
import { WorkspaceShell } from "./workspace/WorkspaceShell";

/** The whole app: the workspace shell, which hosts the docs app as one of its views, behind the first-run wizard. */
export function App() {
  const { wizardOpen } = useOnboarding();
  return (
    <>
      <OnboardingGate api={api}>
        <WorkspaceShell api={api} />
      </OnboardingGate>
      <TipsHost api={api} suppressed={wizardOpen} />
      <FeatureWallHost api={api} firstRun={wizardOpen} />
      <LinksChoiceHost />
      <LspHost api={api} />
    </>
  );
}
