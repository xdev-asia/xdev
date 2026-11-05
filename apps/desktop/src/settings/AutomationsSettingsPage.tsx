import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import { toApiError, type ApiError, type AutomationsSettings } from "@/api";
import { useI18n } from "@/i18n";
import { setAutomationsSettings } from "./automationsSettings";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

const IDS = ["automations.showButton", "automations.confirmDelete", "automations.open"];
const STEPS = ["step1", "step2", "step3"] as const;

/** Settings → Automations: the sidebar entry, the delete confirmation, and a short tour of how it works. */
export function AutomationsSettingsPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter, openView } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<AutomationsSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.automationsSettings().then(setSettings, (e: unknown) => setError(toApiError(e).code));
  }, [api]);

  // The put returns what was stored; the page and the window's copy show that.
  async function patch(change: Partial<AutomationsSettings>): Promise<void> {
    if (!settings || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const stored = await api.automationsSettingsPut({ ...settings, ...change });
      setSettings(stored);
      setAutomationsSettings(stored);
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  const sw = (id: string, key: string, label: string, on: boolean, flip: () => void, hint: string) => (
    <li className="settings-item" data-switch={key} data-setting-id={id} key={key}>
      <div className="settings-item-text">
        <strong>{label}</strong>
        <span className="settings-path">{hint}</span>
      </div>
      <button type="button" role="switch" className="agent-switch" aria-checked={on} aria-label={label} disabled={busy} onClick={flip} />
    </li>
  );

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.automations.title")}</h3>
        <p>{t("settings.automations.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <SettingGroup ids={IDS} filter={filter}>
        {settings && (
          <ul className="settings-list">
            {settingShown(filter, "automations.showButton") &&
              sw("automations.showButton", "showButton", t("settings.automations.showButton"), settings.showButton, () => void patch({ showButton: !settings.showButton }), t("settings.automations.showButton.hint"))}
            {settingShown(filter, "automations.confirmDelete") &&
              sw("automations.confirmDelete", "confirmDelete", t("settings.automations.confirmDelete"), !settings.skipDeleteConfirm, () => void patch({ skipDeleteConfirm: !settings.skipDeleteConfirm }), t("settings.automations.confirmDelete.hint"))}
          </ul>
        )}
        <SettingRow id="automations.open" filter={filter}>
          <h4 className="settings-group">{t("settings.automations.how.title")}</h4>
          <ol className="au-steps">
            {STEPS.map((s) => (
              <li key={s}>
                <strong>{t(`settings.automations.how.${s}.title`)}</strong>
                <span>{t(`settings.automations.how.${s}.body`)}</span>
              </li>
            ))}
          </ol>
          <Button variant="secondary" data-act="open-automations" onClick={() => openView?.("automations")}>
            {t("settings.automations.open")}
          </Button>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
