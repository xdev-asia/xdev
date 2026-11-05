import { RadioGroup } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n, type Locale } from "@/i18n";
import type { Answers } from "../onboardingState";

const LOCALES: Locale[] = ["en", "vi"];

/** Step 3: the UI language; the switch applies at once, like the one in the top bar. */
export function LanguageStep(props: { onAnswer(a: Answers): void }): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="ws-fields">
      <p className="onb-hint">{t("onboarding.language.hint")}</p>
      <RadioGroup
        name="onboarding-language"
        label={t("language.label")}
        orientation="vertical"
        value={locale}
        options={LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
        onChange={(v) => {
          setLocale(v as Locale);
          props.onAnswer({ language: v as Locale });
        }}
      />
    </div>
  );
}
