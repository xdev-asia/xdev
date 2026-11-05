import { useEffect, useState } from "react";
import type { JSX } from "react";
import { FontField, Segmented, Select, ThemeSwitch, UI_FONT_SUGGESTIONS } from "@xdev-asia/ui";
import { toApiError, type ApiError, type EditorTheme, type SidebarLook, type StatusBarItems, type UiSettings } from "@/api";
import { useI18n } from "@/i18n";
import { applyAppearance } from "@/ui/theme";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

export const EDITOR_THEMES: EditorTheme[] = ["app", "light", "dark"];
export const SIDEBAR_LOOKS: SidebarLook[] = ["default", "tinted"];
export const STATUS_BAR_ITEMS = ["branch", "tokenUsage", "agents", "version"] as const satisfies readonly (keyof StatusBarItems)[];

const LOOK_IDS = ["appearance.theme", "appearance.font", "appearance.sidebar"];
const EDITOR_IDS = ["appearance.editorTheme"];
const STATUS_IDS = STATUS_BAR_ITEMS.map((k) => `appearance.statusBar.${k}`);
const LINK_IDS = ["appearance.terminalLink", "appearance.usageLink"];

/** Settings → Appearance: theme, interface font, sidebar look, editor colours and the status bar. */
export function AppearancePage(props: SettingsSectionProps): JSX.Element {
  const { api, filter, openSection } = props;
  const { t } = useI18n();
  const [ui, setUi] = useState<UiSettings | null>(null);
  const [font, setFont] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.uiSettingsGet().then(
      (s) => {
        setUi(s);
        setFont(s.uiFont);
      },
      (e) => setError(toApiError(e).code),
    );
  }, [api]);

  // Read again before the put: zoom or the restore mode may have changed since the page opened. The
  // stored answer is what shows and what the window applies.
  async function patch(change: Partial<UiSettings>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const stored = await api.uiSettingsPut({ ...(await api.uiSettingsGet()), ...change });
      setUi(stored);
      setFont(stored.uiFont);
      applyAppearance(stored);
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  const saveFont = () => {
    if (ui && font.trim() !== ui.uiFont) void patch({ uiFont: font });
  };

  const editorOptions = EDITOR_THEMES.map((v) => ({ value: v, label: t(`settings.appearance.editor.${v}`) }));

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.appearance.title")}</h3>
        <p>{t("settings.appearance.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <SettingGroup ids={LOOK_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.appearance.look")}</h4>
        <SettingRow id="appearance.theme" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" data-field="theme">
              <span>{t("settings.appearance.theme")}</span>
              {ui && (
                <ThemeSwitch
                  value={ui.theme}
                  disabled={busy}
                  onChange={(next) => void patch({ theme: next })}
                  labels={{
                    group: t("settings.appearance.theme"),
                    system: t("settings.appearance.theme.system"),
                    dark: t("settings.appearance.theme.dark"),
                    light: t("settings.appearance.theme.light"),
                  }}
                />
              )}
              <small className="settings-hint">{t("settings.appearance.themeHint")}</small>
            </div>
          </div>
        </SettingRow>
        <SettingRow id="appearance.font" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" data-field="font">
              <span>{t("settings.appearance.font")}</span>
              <FontField
                value={font}
                suggestions={UI_FONT_SUGGESTIONS}
                placeholder={t("settings.appearance.font.placeholder")}
                aria-label={t("settings.appearance.font")}
                disabled={!ui || busy}
                labels={{ reset: t("settings.appearance.font.reset") }}
                onChange={(next) => {
                  setFont(next);
                  // Clearing goes back to the default at once; typing waits for Enter or leaving the field.
                  if (next === "" && ui && ui.uiFont !== "") void patch({ uiFont: "" });
                }}
                onBlur={saveFont}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveFont();
                }}
              />
              <small className="settings-hint">{t("settings.appearance.fontHint")}</small>
            </div>
          </div>
        </SettingRow>
        <SettingRow id="appearance.sidebar" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" data-field="sidebar">
              <span>{t("settings.appearance.sidebar")}</span>
              {ui && (
                <Segmented
                  label={t("settings.appearance.sidebar")}
                  value={ui.sidebar}
                  disabled={busy}
                  options={SIDEBAR_LOOKS.map((v) => ({ value: v, label: t(`settings.appearance.sidebar.${v}`) }))}
                  onChange={(next) => void patch({ sidebar: next as SidebarLook })}
                />
              )}
              <small className="settings-hint">{t("settings.appearance.sidebarHint")}</small>
            </div>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup ids={EDITOR_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.appearance.editor")}</h4>
        <SettingRow id="appearance.editorTheme" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.appearance.editorLight")}</span>
              {ui && (
                <Select
                  data-field="editorLight"
                  value={ui.editorThemeLight}
                  options={editorOptions}
                  disabled={busy}
                  onChange={(e) => void patch({ editorThemeLight: e.target.value as EditorTheme })}
                />
              )}
            </label>
            <label className="ws-field">
              <span>{t("settings.appearance.editorDark")}</span>
              {ui && (
                <Select
                  data-field="editorDark"
                  value={ui.editorThemeDark}
                  options={editorOptions}
                  disabled={busy}
                  onChange={(e) => void patch({ editorThemeDark: e.target.value as EditorTheme })}
                />
              )}
            </label>
            <small className="settings-hint">{t("settings.appearance.editorHint")}</small>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup ids={STATUS_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.appearance.statusBar")}</h4>
        {ui && (
          <ul className="settings-list">
            {STATUS_BAR_ITEMS.map(
              (k) =>
                settingShown(filter, `appearance.statusBar.${k}`) && (
                  <li className="settings-item" data-switch={k} data-setting-id={`appearance.statusBar.${k}`} key={k}>
                    <div className="settings-item-text">
                      <strong>{t(`settings.appearance.statusBar.${k}`)}</strong>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      className="agent-switch"
                      aria-checked={ui.statusBar[k]}
                      aria-label={t(`settings.appearance.statusBar.${k}`)}
                      disabled={busy}
                      onClick={() => void patch({ statusBar: { ...ui.statusBar, [k]: !ui.statusBar[k] } })}
                    />
                  </li>
                ),
            )}
          </ul>
        )}
      </SettingGroup>

      {openSection && (
        <SettingGroup ids={LINK_IDS} filter={filter}>
          <h4 className="settings-group">{t("settings.appearance.related")}</h4>
          <SettingRow id="appearance.terminalLink" filter={filter}>
            <div className="settings-actions settings-actions-start">
              <button type="button" className="btn-secondary" data-act="open-terminal" onClick={() => openSection("terminal")}>
                {t("settings.appearance.terminalLink")}
              </button>
            </div>
          </SettingRow>
          <SettingRow id="appearance.usageLink" filter={filter}>
            <div className="settings-actions settings-actions-start">
              <button type="button" className="btn-secondary" data-act="open-usage" onClick={() => openSection("usage")}>
                {t("settings.appearance.usageLink")}
              </button>
            </div>
          </SettingRow>
        </SettingGroup>
      )}
    </div>
  );
}
