import { Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type OnNameTaken, type SchemePreview, type TerminalGpu } from "@/api";
import { useI18n } from "@/i18n";
import { loadCustomSchemes, useCustomSchemes } from "@/terminal/customSchemes";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { THEME_APP } from "@/settings/terminalDefaults";
import { TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { SettingGroup, SettingRow } from "../SettingRow";
import { ANSI_KEYS } from "./ansiKeys";
import { ImportSchemeDialog, type ImportError } from "./ImportSchemeDialog";
import { parseNumber, type TerminalSectionProps } from "./sectionProps";

export const GPU_MODES: TerminalGpu[] = ["auto", "on", "off"];
const THEME_IDS = ["terminal.theme", "terminal.themeImport"];
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
  const [listError, setListError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (api) void loadCustomSchemes(api);
  }, [api]);
  // The contrast while it is being typed in; written on blur or Enter.
  const [contrast, setContrast] = useState<string | undefined>(undefined);
  const scheme = TERMINAL_SCHEMES.find((s) => s.id === current.theme) ?? custom.find((s) => s.id === current.theme);

  async function startImport(): Promise<void> {
    if (!api) return;
    setListError(undefined);
    const path = await api.pickFile(["json"]).catch(() => null);
    if (!path) return;
    try {
      setImporting({ path, preview: await api.terminalThemePreview(path) });
    } catch (e) {
      const err = toApiError(e);
      setImporting({ path, preview: null, error: { code: err.code, detail: err.detail } });
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
      </SettingGroup>

      {api && (
        <SettingGroup ids={["terminal.themeImport"]} filter={filter}>
          <SettingRow id="terminal.themeImport" filter={filter}>
            <div className="ws-fields">
              <div className="ws-field">
                <Button type="button" variant="secondary" data-field="import" disabled={busy || importBusy} onClick={() => void startImport()}>
                  {t("settings.terminal.import.button")}
                </Button>
                <small className="settings-hint">{t("settings.terminal.import.hint")}</small>
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
