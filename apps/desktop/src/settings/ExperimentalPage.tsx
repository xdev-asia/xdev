import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "./sections";

/** Experimental features: each one links to the page where its switch lives. */
export const EXPERIMENTAL_FEATURES: { id: string; section: string; labelKey: string; hintKey: string }[] = [
  { id: "experimental.autoSleep", section: "agents", labelKey: "settings.agents.autoSleep.label", hintKey: "settings.agents.autoSleep.hint" },
];

export function ExperimentalPage(props: SettingsSectionProps): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-page">
      <h3>{t("settings.experimental.title")}</h3>
      <p className="settings-path">{t("settings.experimental.intro")}</p>
      {EXPERIMENTAL_FEATURES.length === 0 ? (
        <p className="settings-empty" role="status">{t("settings.experimental.empty")}</p>
      ) : (
        <ul className="settings-list" data-section="experimental">
          {EXPERIMENTAL_FEATURES.map((f) => (
            <li key={f.id} className="settings-item">
              <div className="settings-item-text">
                <strong>{t(f.labelKey)}</strong>
                <span className="settings-path">{t(f.hintKey)}</span>
              </div>
              <Button variant="secondary" type="button" data-field={f.id} onClick={() => props.openSection?.(f.section)}>
                {t("settings.experimental.autoSleep.open")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
