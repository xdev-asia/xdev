import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type RestoreMode } from "@/api";
import { useI18n } from "@/i18n";

export const RESTORE_MODES: RestoreMode[] = ["all", "agentsOnly", "none"];

/** Settings → General → On start, reopen tabs: what a restart brings back (`UiSettings.restore`). */
export function RestoreSetting(props: { api: Pick<Api, "uiSettingsGet" | "uiSettingsPut"> }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [mode, setMode] = useState<RestoreMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.uiSettingsGet().then((s) => setMode(s.restore), (e) => setError(toApiError(e).code));
  }, [api]);

  async function pick(next: RestoreMode): Promise<void> {
    if (busy || next === mode) return;
    setBusy(true);
    setError(undefined);
    try {
      // Read again: the zoom may have changed since the page opened.
      const stored = await api.uiSettingsPut({ ...(await api.uiSettingsGet()), restore: next });
      setMode(stored.restore);
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h4 className="settings-group">{t("layout.setting")}</h4>
      <div className="ws-fields">
        <div className="ws-field" role="radiogroup" aria-label={t("layout.setting")}>
          <div className="term-radios">
            {RESTORE_MODES.map((m) => (
              <label key={m} className="term-radio">
                <input
                  type="radio"
                  name="restore-mode"
                  value={m}
                  checked={mode === m}
                  disabled={busy || mode === null}
                  data-restore={m}
                  onChange={() => void pick(m)}
                />
                {t(`layout.mode.${m}`)}
              </label>
            ))}
          </div>
          <small className="settings-hint">{t("layout.setting.hint")}</small>
        </div>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
    </>
  );
}
