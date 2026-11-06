import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type BrowserSettings, type LinksTarget } from "@/api";
import { saveLinksAsked } from "@/browser/linksChoice";
import { loadBrowserSettings, setBrowserSettings, useBrowserSettings } from "@/browser/browserSettings";
import { useI18n } from "@/i18n";
import { SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

export const LINK_TARGETS: LinksTarget[] = ["system", "pane"];

/** Settings → Browser: where terminal links open, and what the address field searches with. */
export function BrowserPage({ api, filter }: SettingsSectionProps): JSX.Element {
  const { t } = useI18n();
  const current = useBrowserSettings();
  const [busy, setBusy] = useState(false);
  // The template while it is typed; written on blur or Enter.
  const [template, setTemplate] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadBrowserSettings(api);
  }, [api]);

  async function save(next: BrowserSettings): Promise<boolean> {
    setBusy(true);
    try {
      setBrowserSettings(await api.browserSettingsPut(next));
      setError(null);
      return true;
    } catch (e) {
      setError(t(`error.${toApiError(e).code}`));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function commitTemplate(): Promise<void> {
    if (template === undefined) return;
    if (template.trim() === current.searchTemplate) {
      setTemplate(undefined);
      setError(null);
      return;
    }
    if (await save({ ...current, searchTemplate: template })) setTemplate(undefined);
  }

  return (
    <div className="settings-page">
      <h3>{t("settings.browser.title")}</h3>
      <p className="settings-path">{t("settings.browser.intro")}</p>
      <SettingRow id="browser.openLinksIn" filter={filter}>
        <div className="ws-fields">
          <div className="ws-field" role="radiogroup" aria-label={t("settings.browser.openLinksIn")}>
            <span>{t("settings.browser.openLinksIn")}</span>
            <div className="term-radios">
              {LINK_TARGETS.map((m) => (
                <label key={m} className="term-radio">
                  <input
                    type="radio"
                    name="browser-open-links-in"
                    value={m}
                    checked={current.openLinksIn === m}
                    disabled={busy}
                    data-links-target={m}
                    onChange={() => void save({ ...current, openLinksIn: m }).then((ok) => ok && saveLinksAsked())}
                  />
                  {t(`settings.browser.openLinksIn.${m}`)}
                </label>
              ))}
            </div>
            <small className="settings-hint">{t("settings.browser.openLinksInHint")}</small>
          </div>
        </div>
      </SettingRow>
      <SettingRow id="browser.searchTemplate" filter={filter}>
        <div className="ws-fields">
          <label className="ws-field" data-invalid={error ? "" : undefined}>
            <span>{t("settings.browser.searchTemplate")}</span>
            <input
              type="text"
              data-field="searchTemplate"
              spellCheck={false}
              autoComplete="off"
              placeholder={t("settings.browser.searchTemplatePlaceholder")}
              value={template ?? current.searchTemplate}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setTemplate(e.target.value);
                setError(null);
              }}
              onBlur={() => void commitTemplate()}
              onKeyDown={(e) => e.key === "Enter" && void commitTemplate()}
            />
            {error ? (
              <small className="settings-error" role="alert">
                {error}
              </small>
            ) : (
              <small className="settings-hint">{t("settings.browser.searchTemplateHint")}</small>
            )}
          </label>
        </div>
      </SettingRow>
    </div>
  );
}
