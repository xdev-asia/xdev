import { useLayoutEffect, useState } from "react";
import type { Api } from "@/api";
import { deriveChecklist, type Known, type Row } from "./checklist";
import { useOnboarding } from "./onboardingStore";

/** The key the language switch stores its pick under (`i18n/index.ts`). */
const LOCALE_KEY = "xdev-locale";

function hasStoredLocale(): boolean {
  try {
    return localStorage.getItem(LOCALE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The setup checklist, or null until the app state is read. It reads again when the wizard's answers
 * change, when the guide opens, and when `refreshKey` changes (the sidebar's project count).
 */
export function useChecklist(api: Pick<Api, "profiles" | "uiSettingsGet" | "workspaceSidebar">, refreshKey?: unknown): Row[] | null {
  const { saved, guideOpen, wizardOpen } = useOnboarding();
  const [known, setKnown] = useState<Known | null>(null);

  // A layout effect only starts the read: nothing paints from it, and it stays out of the way of a parent that counts its own effects.
  useLayoutEffect(() => {
    let stale = false;
    // A part that cannot be read stays unknown, so the answers alone decide it.
    Promise.all([
      api.profiles().then((v) => v.defaultAgent, () => null),
      api.uiSettingsGet().then((u) => u.theme as string, () => null),
      api.workspaceSidebar().then((items) => items.length, () => null),
    ]).then(([defaultAgent, theme, projects]) => {
      if (!stale) setKnown({ defaultAgent, theme, projects, storedLocale: hasStoredLocale() });
    });
    return () => {
      stale = true;
    };
  }, [api, saved, guideOpen, wizardOpen, refreshKey]);

  return known ? deriveChecklist(known, saved.answers) : null;
}
