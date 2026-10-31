import type { JSX } from "react";
import { useI18n, type Locale } from "../i18n";

const LOCALES: Locale[] = ["en", "vi"];

export function LanguageSwitch(): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="segmented" role="group" aria-label={t("language.label")}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          title={t(`language.${l}`)}
          lang={l}
          onClick={() => setLocale(l)}
        >
          {t(`language.short.${l}`)}
        </button>
      ))}
    </div>
  );
}
