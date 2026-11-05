import { Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ConfigKind, type OnNameTaken, type SchemePreview, type TermConfigDetected, type TermConfigPreview, type TerminalGpu } from "@/api";
import { useI18n } from "@/i18n";
import { loadCustomSchemes, useCustomSchemes } from "@/terminal/customSchemes";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { THEME_APP } from "@/settings/terminalDefaults";
import { TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { SettingGroup, SettingRow, settingShown } from "../SettingRow";
import { ANSI_KEYS } from "./ansiKeys";
import { ImportConfigDialog } from "./ImportConfigDialog";
import { configChange, configRows, type ConfigRowId } from "./importConfig";
import { ImportSchemeDialog, type ImportError } from "./ImportSchemeDialog";
import { parseNumber, type TerminalSectionProps } from "./sectionProps";

export const GPU_MODES: TerminalGpu[] = ["auto", "on", "off"];
const THEME_IDS = ["terminal.theme", "terminal.themeFollowApp", "terminal.themeLight", "terminal.themeImport"];
const RENDER_IDS = ["terminal.gpu", "terminal.minimumContrast"];
export { ANSI_KEYS };

/** Settings → Terminal → Theme and Rendering. */
export function TerminalLookSection(props: TerminalSectionProps): JSX.Element {
  const { api, current, busy, patch, filter } = props;
  const { t } = useI18n();
  const custom = useCustomSchemes();
  // The import in progress: the file, what Rust made of it, or why it could not.
  const [importing, setImporting] = useState<{ path: string; preview: SchemePreview | null; error?: ImportError } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  // The config import in progress: what was detected, the config read and the rows ticked.
  const [cfg, setCfg] = useState<{ detected: TermConfigDetected | null; kind: ConfigKind | null; path: string | null; preview: TermConfigPreview | null; checked: Set<ConfigRowId>; error?: ImportError } | null>(null);
  const [listError, setListError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (api) void loadCustomSchemes(api);
  }, [api]);
  // The contrast while it is being typed in; written on blur or Enter.
  const [contrast, setContrast] = useState<string | undefined>(undefined);
  const scheme = TERMINAL_SCHEMES.find((s) => s.id === current.theme) ?? custom.find((s) => s.id === current.theme);
  const lightScheme = TERMINAL_SCHEMES.find((s) => s.id === current.themeLight) ?? custom.find((s) => s.id === current.themeLight);

  async function startImport(): Promise<void> {
    if (!api) return;
    setListError(undefined);
    const path = await api.pickFile(["json", "yaml", "yml", "itermcolors"]).catch(() => null);
    if (!path) return;
    try {
      setImporting({ path, preview: await api.terminalThemePreview(path) });
    } catch (e) {
      const err = toApiError(e);
      setImporting({ path, preview: null, error: { code: err.code, detail: err.detail } });
    }
  }

  const schemeName = (id: string): string | null => scheme?.id === id ? scheme.name : custom.find((c) => c.id === id)?.name ?? null;

  async function startConfigImport(): Promise<void> {
    if (!api) return;
    const detected = await api.termConfigDetect().catch(() => null);
    setCfg({ detected, kind: null, path: null, preview: null, checked: new Set() });
  }

  async function readConfig(kind: ConfigKind, path: string | null): Promise<void> {
    if (!api) return;
    try {
      const preview = await api.termConfigRead(kind, path);
      const rows = configRows(current, preview, schemeName(current.theme));
      setCfg((c) => ({ detected: c?.detected ?? null, kind, path, preview, checked: new Set(rows.map((r) => r.id)) }));
    } catch (e) {
      const err = toApiError(e);
      setCfg((c) => ({ detected: c?.detected ?? null, kind, path, preview: null, checked: new Set(), error: { code: err.code, detail: err.detail } }));
    }
  }

  async function chooseConfigFile(kind: ConfigKind): Promise<void> {
    if (!api) return;
    const path = await api.pickFile(["conf", "config", "*"]).catch(() => null);
    if (path) await readConfig(kind, path);
  }

  async function applyConfig(): Promise<void> {
    if (!api || !cfg?.preview || !cfg.kind || importBusy) return;
    setImportBusy(true);
    try {
      const { change, saveScheme } = configChange(cfg.preview, cfg.checked);
      if (saveScheme) {
        const saved = await api.termConfigSaveScheme(cfg.kind, cfg.path);
        await loadCustomSchemes(api);
        change.theme = saved.id;
      }
      await patch(change);
      setCfg(null);
    } catch (e) {
      const err = toApiError(e);
      setCfg({ ...cfg, error: { code: err.code, detail: err.detail } });
    } finally {
      setImportBusy(false);
    }
  }

  async function finishImport(onTaken: OnNameTaken): Promise<void> {
    if (!api || !importing || importBusy) return;
    setImportBusy(true);
    try {
      await api.terminalThemeImport(importing.path, onTaken);
      await loadCustomSchemes(api);
      setImporting(null);
    } catch (e) {
      const err = toApiError(e);
      setImporting({ ...importing, error: { code: err.code, detail: err.detail } });
    } finally {
      setImportBusy(false);
    }
  }

  async function removeScheme(id: string): Promise<void> {
    if (!api) return;
    setListError(undefined);
    try {
      await api.terminalThemeRemove(id);
      await loadCustomSchemes(api);
      // A terminal still pointing at the removed scheme goes back to the app colours.
      if (current.theme === id) await patch({ theme: THEME_APP });
    } catch (e) {
      setListError(toApiError(e).code);
    }
  }

  function commitContrast(): void {
    if (contrast === undefined) return;
    const value = parseNumber(contrast, 1);
    setContrast(undefined);
    if (value === null || value === current.minimumContrast) return;
    void patch({ minimumContrast: value });
  }

  return (
    <>
      <SettingGroup ids={THEME_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.theme.group")}</h4>
        <SettingRow id="terminal.theme" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.terminal.theme.label")}</span>
              <select
                value={scheme ? scheme.id : THEME_APP}
                disabled={busy}
                data-field="theme"
                onChange={(e) => void patch({ theme: e.target.value })}
              >
                <option value={THEME_APP}>{t("settings.terminal.theme.app")}</option>
                {TERMINAL_SCHEMES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {custom.length > 0 && (
                  <optgroup label={t("settings.terminal.theme.imported")}>
                    {custom.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <small className="settings-hint">{t("settings.terminal.theme.hint")}</small>
            </label>
          </div>
          {scheme ? (
            <div className="term-swatches" data-field="swatches" role="img" aria-label={t("settings.terminal.theme.swatches")}>
              {ANSI_KEYS.map((k) => (
                <span key={k} className="term-swatch" data-swatch={k} style={{ background: scheme.colors[k] }} />
              ))}
            </div>
          ) : (
            <p className="settings-hint" data-field="swatches-app">
              {t("settings.terminal.theme.appNote")}
            </p>
          )}
        </SettingRow>
        <ul className="settings-list">
          {settingShown(filter, "terminal.themeFollowApp") && (
            <li className="settings-item" data-switch="themeFollowApp" data-setting-id="terminal.themeFollowApp">
              <div className="settings-item-text">
                <strong>{t("settings.terminal.theme.followApp")}</strong>
                <small className="settings-hint">{t("settings.terminal.theme.followAppHint")}</small>
              </div>
              <button
                type="button"
                role="switch"
                className="agent-switch"
                aria-checked={current.themeFollowApp}
                aria-label={t("settings.terminal.theme.followApp")}
                disabled={busy}
                onClick={() => void patch({ themeFollowApp: !current.themeFollowApp })}
              />
            </li>
          )}
        </ul>
        {current.themeFollowApp && (
          <SettingRow id="terminal.themeLight" filter={filter}>
            <div className="ws-fields">
              <label className="ws-field">
                <span>{t("settings.terminal.theme.light")}</span>
                <select
                  value={lightScheme ? lightScheme.id : THEME_APP}
                  disabled={busy}
                  data-field="themeLight"
                  onChange={(e) => void patch({ themeLight: e.target.value })}
                >
                  <option value={THEME_APP}>{t("settings.terminal.theme.app")}</option>
                  {TERMINAL_SCHEMES.filter((x) => x.mode === "light").map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                  <optgroup label={t("settings.terminal.theme.darkGroup")}>
                    {TERMINAL_SCHEMES.filter((x) => x.mode === "dark").map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </optgroup>
                  {custom.length > 0 && (
                    <optgroup label={t("settings.terminal.theme.imported")}>
                      {custom.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            </div>
          </SettingRow>
        )}
      </SettingGroup>

      {api && (
        <SettingGroup ids={["terminal.themeImport"]} filter={filter}>
          <SettingRow id="terminal.themeImport" filter={filter}>
            <div className="ws-fields">
              <div className="ws-field">
                <Button type="button" variant="secondary" data-field="import" disabled={busy || importBusy} onClick={() => void startImport()}>
                  {t("settings.terminal.import.button")}
                </Button>
                <small className="settings-hint">{t("settings.terminal.import.hintFormats")}</small>
              </div>
              <div className="ws-field">
                <Button type="button" variant="secondary" data-field="import-config" disabled={busy || importBusy} onClick={() => void startConfigImport()}>
                  {t("settings.terminal.importConfig.button")}
                </Button>
                <small className="settings-hint">{t("settings.terminal.importConfig.hint")}</small>
              </div>
            </div>
            {custom.length > 0 && (
              <ul className="settings-list" data-field="imported">
                {custom.map((s) => (
                  <li className="settings-item" key={s.id}>
                    <div className="settings-item-text">
                      <strong>{s.name}</strong>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      data-remove={s.id}
                      aria-label={t("settings.terminal.import.removeNamed", { name: s.name })}
                      disabled={busy || importBusy}
                      onClick={() => void removeScheme(s.id)}
                    >
                      {t("settings.terminal.import.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {listError && (
              <p className="error-text" role="alert">
                {t(`error.${listError}`)}
              </p>
            )}
          </SettingRow>
          <ImportSchemeDialog
            open={importing !== null}
            preview={importing?.preview ?? null}
            error={importing?.error}
            busy={importBusy}
            onImport={(onTaken) => void finishImport(onTaken)}
            onCancel={() => setImporting(null)}
          />
          <ImportConfigDialog
            open={cfg !== null}
            detected={cfg?.detected ?? null}
            kind={cfg?.kind ?? null}
            preview={cfg?.preview ?? null}
            rows={cfg?.preview ? configRows(current, cfg.preview, schemeName(current.theme)) : []}
            checked={cfg?.checked ?? new Set()}
            error={cfg?.error}
            busy={importBusy}
            onPick={(k) => void readConfig(k, cfg?.detected?.[k] ?? null)}
            onChooseFile={(k) => void chooseConfigFile(k)}
            onToggle={(id) =>
              setCfg((c) => {
                if (!c) return c;
                const checked = new Set(c.checked);
                if (!checked.delete(id)) checked.add(id);
                return { ...c, checked };
              })
            }
            onApply={() => void applyConfig()}
            onCancel={() => setCfg(null)}
          />
        </SettingGroup>
      )}
      <SettingGroup ids={RENDER_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.render.group")}</h4>
        <SettingRow id="terminal.gpu" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" role="radiogroup" aria-label={t("settings.terminal.render.gpu")}>
              <span>{t("settings.terminal.render.gpu")}</span>
              <div className="term-radios">
                {GPU_MODES.map((m) => (
                  <label key={m} className="term-radio">
                    <input
                      type="radio"
                      name="terminal-gpu"
                      value={m}
                      checked={current.gpu === m}
                      disabled={busy}
                      data-gpu={m}
                      onChange={() => void patch({ gpu: m })}
                    />
                    {t(`settings.terminal.render.gpu.${m}`)}
                  </label>
                ))}
              </div>
              <small className="settings-hint">{t("settings.terminal.render.gpuHint")}</small>
            </div>
          </div>
        </SettingRow>
        <SettingRow id="terminal.minimumContrast" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.terminal.render.contrast")}</span>
              <input
                type="number"
                step={0.1}
                min={TERMINAL_LIMITS.minimumContrast.min}
                max={TERMINAL_LIMITS.minimumContrast.max}
                value={contrast ?? String(current.minimumContrast)}
                disabled={busy}
                data-field="minimumContrast"
                onChange={(e) => setContrast(e.target.value)}
                onBlur={commitContrast}
                onKeyDown={(e) => e.key === "Enter" && commitContrast()}
              />
              <small className="settings-hint">{t("settings.terminal.render.contrastHint")}</small>
            </label>
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
