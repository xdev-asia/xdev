import { Segmented } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { Theme } from "@xdev/bindings";
import { useI18n } from "@/i18n";
import type { Answers } from "../onboardingState";

const THEMES: Theme[] = ["system", "light", "dark"];

/** Step 2: light, dark or follow the system; the choice paints at once. */
export function LookStep(props: { theme: Theme; answers: Answers; onAnswer(a: Answers): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="ws-fields">
      <p className="onb-hint">{t("onboarding.look.hint")}</p>
      <Segmented
        label={t("settings.appearance.theme")}
        value={props.answers.theme ?? props.theme}
        options={THEMES.map((v) => ({ value: v, label: t(`settings.appearance.theme.${v}`) }))}
        onChange={(v) => props.onAnswer({ theme: v as Theme })}
      />
    </div>
  );
}
