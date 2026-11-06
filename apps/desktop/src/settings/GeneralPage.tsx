import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type DiffSettings, type NavigationSettings, type ShellSettings } from "@/api";
import { useI18n, type LocalePreference } from "@/i18n";
import { PLATFORM } from "@/platform";
import { clampZoom, getZoom, stepZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "@/ui/zoom";
import { setNavigationSettings } from "./navigationSettings";
import { RestoreSetting } from "./RestoreSetting";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import { UpdatesSetting } from "./UpdatesSetting";
import { TipsSetting } from "@/tips/TipsSetting";
import type { SettingsSectionProps } from "./sections";

export const TAB_ORDERS: NavigationSettings["tabOrder"][] = ["mru", "sequential"];
export const DIFF_VIEWS: DiffSettings["defaultView"][] = ["inline", "split"];
export const NAVIGATION_SWITCHES = ["confirmClosePinned", "confirmCloseRunning", "askBeforeDeleteWorktree", "alwaysForceDeleteWorktrees", "alwaysDeleteKeptBranches"] as const;
export const DIFF_SWITCHES = ["ignoreWhitespace", "collapseUnchanged", "wordWrap", "fileTree"] as const;
// 50 % … 200 % in steps of `ZOOM_STEP`.
// Catalog ids of the page, per group; a switch adds its key (`general.nav.confirmClosePinned`).
const NAVIGATION_IDS = ["general.tabOrder", ...NAVIGATION_SWITCHES.map((k) => `general.nav.${k}`)];
const LOCALES: LocalePreference[] = ["system", "en", "vi"];
const WORKSPACE_IDS = ["general.language", "general.zoom", "general.restore", "general.tips", "general.openIn"];
const UPDATE_IDS = ["general.updates", "general.updateChannel", "general.updateRemind"];
const DIFF_IDS = ["general.diffView", ...DIFF_SWITCHES.map((k) => `general.diff.${k}`)];
export const ZOOM_LEVELS: number[] = Array.from({ length: Math.round((ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP) + 1 }, (_, i) => clampZoom(ZOOM_MIN + i * ZOOM_STEP));

/** Settings → General: navigation, workspace and diff preferences of the whole app. */
export function GeneralPage(props: SettingsSectionProps): JSX.Element {
  const { api, openSection, filter } = props;
  const { t, locale, preference, setLocale } = useI18n();
  const [navigation, setNavigation] = useState<NavigationSettings | null>(null);
  const [diff, setDiff] = useState<DiffSettings | null>(null);
  const [zoom, setZoom] = useState(() => getZoom());
  const [shell, setShell] = useState<ShellSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    const fail = (e: unknown) => setError(toApiError(e).code);
    api.navigationSettings().then(setNavigation, fail);
    api.diffSettings().then(setDiff, fail);
    api.shellSettings().then(setShell, fail);
    api.uiSettingsGet().then((s) => {
      setZoom(clampZoom(s.zoom));
    }, fail);
  }, [api]);

  // Each write returns what was stored; the page shows that, not what it asked for.
  async function write(run: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  const patchNavigation = (change: Partial<NavigationSettings>) =>
    navigation && write(async () => {
      const stored = await api.navigationSettingsPut({ ...navigation, ...change });
      setNavigation(stored);
      // The open tab strips read the shared copy, so the change applies without a reload.
      setNavigationSettings(stored);
    });
  const patchDiff = (change: Partial<DiffSettings>) =>
    diff && write(async () => setDiff(await api.diffSettingsPut({ ...diff, ...change })));
  // Read again before the put: the update channel may have changed (a Shift check) since the page opened.
  const patchShell = (change: Partial<ShellSettings>) =>
    shell && write(async () => setShell(await api.shellSettingsPut({ ...(await api.shellSettings()), ...change })));
  // A step from the level the window shows; `0` resets to 100 %.
  const pickZoom = (next: number | null) =>
    write(async () => setZoom(await stepZoom(api, next === null ? 0 : clampZoom(next) - getZoom())));

  const sw = (id: string, key: string, label: string, on: boolean, flip: () => void, hint?: string) => (
    <li className="settings-item" data-switch={key} data-setting-id={id} key={key}>
      <div className="settings-item-text">
        <strong>{label}</strong>
        {hint && <span className="settings-path">{hint}</span>}
      </div>
      <button type="button" role="switch" className="agent-switch" aria-checked={on} aria-label={label} disabled={busy} onClick={flip} />
    </li>
  );

  // The tray is on Windows and the menu bar on macOS; Linux has neither.
  const windowIds = PLATFORM === "win" ? ["general.minimizeToTray"] : PLATFORM === "mac" ? ["general.menuBarIcon", "general.notchStatus"] : [];

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.general.title")}</h3>
        <p>{t("settings.general.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <SettingGroup ids={NAVIGATION_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.general.navigation")}</h4>
      {navigation && (
        <>
          <SettingRow id="general.tabOrder" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" role="radiogroup" aria-label={t("settings.general.tabOrder")}>
              <span>{t("settings.general.tabOrder")}</span>
              <div className="segmented">
                {TAB_ORDERS.map((o) => (
                  <button
                    key={o}
                    type="button"
                    role="radio"
                    data-tab-order={o}
                    aria-checked={navigation.tabOrder === o}
                    disabled={busy}
                    onClick={() => void patchNavigation({ tabOrder: o })}
                  >
                    {t(`settings.general.tabOrder.${o}`)}
                  </button>
                ))}
              </div>
              <small className="settings-hint">{t("settings.general.tabOrderHint")}</small>
            </div>
          </div>
          </SettingRow>
          <ul className="settings-list">
            {NAVIGATION_SWITCHES.map((k) =>
              settingShown(filter, `general.nav.${k}`) && sw(`general.nav.${k}`, k, t(`settings.general.${k}`), navigation[k], () => void patchNavigation({ [k]: !navigation[k] }), k === "confirmCloseRunning" ? t("settings.general.confirmCloseRunningHint") : undefined),
            )}
          </ul>
        </>
      )}
      </SettingGroup>

      <SettingGroup ids={WORKSPACE_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.general.workspace")}</h4>
      <SettingRow id="general.language" filter={filter}>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("language.label")}</span>
          <select value={preference ?? locale} data-field="language" onChange={(e) => setLocale(e.target.value as LocalePreference)}>
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l === "system" ? undefined : l}>
                {t(`language.${l}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      </SettingRow>
      <SettingRow id="general.zoom" filter={filter}>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("settings.general.zoom")}</span>
          <select value={zoom} disabled={busy} data-field="zoom" onChange={(e) => void pickZoom(Number(e.target.value))}>
            {ZOOM_LEVELS.map((z) => (
              <option key={z} value={z}>
                {Math.round(z * 100)} %
              </option>
            ))}
          </select>
        </label>
        <div className="settings-actions settings-actions-start">
          <button type="button" className="btn-secondary" data-act="zoom-reset" disabled={busy} onClick={() => void pickZoom(null)}>
            {t("settings.general.zoomReset")}
          </button>
        </div>
      </div>
      </SettingRow>
      <SettingRow id="general.restore" filter={filter}>
        <RestoreSetting api={api} />
      </SettingRow>
      <SettingRow id="general.tips" filter={filter}>
        <TipsSetting />
      </SettingRow>
      {openSection && (
        <SettingRow id="general.openIn" filter={filter}>
          <div className="settings-actions settings-actions-start">
            <button type="button" className="btn-secondary" data-act="open-in" onClick={() => openSection("openIn")}>
              {t("settings.general.openIn")}
            </button>
          </div>
        </SettingRow>
      )}
      </SettingGroup>

      {windowIds.length > 0 && (
      <SettingGroup ids={windowIds} filter={filter}>
      <h4 className="settings-group">{t("settings.general.window")}</h4>
      {shell && (
        <ul className="settings-list">
          {PLATFORM === "win" && settingShown(filter, "general.minimizeToTray") && sw("general.minimizeToTray", "minimizeToTray", t("settings.general.minimizeToTray"), shell.minimizeToTray, () => void patchShell({ minimizeToTray: !shell.minimizeToTray }), t("settings.general.minimizeToTrayHint"))}
          {PLATFORM === "mac" && settingShown(filter, "general.menuBarIcon") && sw("general.menuBarIcon", "menuBarIcon", t("settings.general.menuBarIcon"), shell.menuBarIcon, () => void patchShell({ menuBarIcon: !shell.menuBarIcon }), t("settings.general.menuBarIconHint"))}
          {PLATFORM === "mac" && settingShown(filter, "general.notchStatus") && sw("general.notchStatus", "notchStatus", t("settings.general.notchStatus"), shell.notchStatus, () => void patchShell({ notchStatus: !shell.notchStatus }), t("settings.general.notchStatusHint"))}
        </ul>
      )}
      </SettingGroup>
      )}

      <SettingGroup ids={UPDATE_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.general.updates")}</h4>
      <UpdatesSetting api={api} filter={filter} onError={setError} />
      </SettingGroup>

      <SettingGroup ids={DIFF_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.general.diff")}</h4>
      {diff && (
        <>
          <SettingRow id="general.diffView" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" role="radiogroup" aria-label={t("settings.general.diffView")}>
              <span>{t("settings.general.diffView")}</span>
              <div className="segmented">
                {DIFF_VIEWS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    data-diff-view={v}
                    aria-checked={diff.defaultView === v}
                    disabled={busy}
                    onClick={() => void patchDiff({ defaultView: v })}
                  >
                    {t(`settings.general.diffView.${v}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          </SettingRow>
          <ul className="settings-list">
            {DIFF_SWITCHES.map((k) => settingShown(filter, `general.diff.${k}`) && sw(`general.diff.${k}`, k, t(`settings.general.${k}`), diff[k], () => void patchDiff({ [k]: !diff[k] }), k === "fileTree" ? t("settings.general.fileTreeHint") : undefined))}
          </ul>
        </>
      )}
      </SettingGroup>
    </div>
  );
}
