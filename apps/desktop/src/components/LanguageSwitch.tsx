import type { JSX } from "react";
import { useI18n, type LocalePreference } from "@/i18n";

const LOCALES: LocalePreference[] = ["system", "en", "vi"];

export function LanguageSwitch(): JSX.Element {
  const { locale, preference, setLocale, t } = useI18n();
  return (
    <select
      className="lang-select"
      aria-label={t("language.label")}
      title={t("language.label")}
      value={preference ?? locale}
      onChange={(e) => setLocale(e.target.value as LocalePreference)}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={l === "system" ? undefined : l}>
          {t(`language.${l}`)}
        </option>
      ))}
    </select>
  );
}
