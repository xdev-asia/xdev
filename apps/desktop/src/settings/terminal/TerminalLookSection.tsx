import { useState } from "react";
import type { JSX } from "react";
import type { TerminalGpu } from "@/api";
import { useI18n } from "@/i18n";
import { TERMINAL_SCHEMES } from "@/terminal/terminalThemes";
import { THEME_APP } from "@/settings/terminalDefaults";
import { TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { SettingGroup, SettingRow } from "../SettingRow";
import { parseNumber, type TerminalSectionProps } from "./sectionProps";

export const GPU_MODES: TerminalGpu[] = ["auto", "on", "off"];
const THEME_IDS = ["terminal.theme"];
const RENDER_IDS = ["terminal.gpu", "terminal.minimumContrast"];
// The 16 ANSI colours, in palette order.
export const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/** Settings → Terminal → Theme and Rendering. */
export function TerminalLookSection(props: TerminalSectionProps): JSX.Element {
  const { current, busy, patch, filter } = props;
  const { t } = useI18n();
  // The contrast while it is being typed in; written on blur or Enter.
  const [contrast, setContrast] = useState<string | undefined>(undefined);
  const scheme = TERMINAL_SCHEMES.find((s) => s.id === current.theme);

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
