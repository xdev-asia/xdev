import type { JSX } from "react";
import { useI18n, type Locale } from "../i18n";

const LOCALES: Locale[] = ["en", "vi"];

export function LanguageSwitch(): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      className="lang-select"
      aria-label={t("language.label")}
      title={t("language.label")}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={l}>
          {t(`language.${l}`)}
        </option>
      ))}
    </select>
  );
}
