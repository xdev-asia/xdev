import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { RadioGroup } from "@xdev-asia/ui";
import type { Api, TerminalHostInfo, WindowsPowershell } from "@/api";
import { useI18n } from "@/i18n";
import { PLATFORM } from "@/platform";
import { TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { SettingGroup, SettingRow, settingShown } from "../SettingRow";
import { parseNumber, type TerminalSectionProps } from "./sectionProps";

export const ADVANCED_IDS = ["terminal.maxRunningTerminals", "terminal.windowsPowershell"] as const;
export const POWERSHELL_CHOICES: readonly WindowsPowershell[] = ["auto", "windows", "pwsh"];
export const POWERSHELL_URL = "https://aka.ms/powershell";

type Host = { state: "loading" } | { state: "failed" } | { state: "ready"; info: TerminalHostInfo };

/** Settings → Terminal → Advanced: the running-terminal cap and, on Windows, which PowerShell a PowerShell tab starts. */
export function TerminalAdvancedSection(
  props: Omit<TerminalSectionProps, "api"> & { api: Pick<Api, "terminalHostInfo" | "openUrl"> },
): JSX.Element | null {
  const { api, current, busy, patch, filter } = props;
  const { t } = useI18n();
  const [host, setHost] = useState<Host>({ state: "loading" });
  const [draft, setDraft] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setHost({ state: "loading" });
    api.terminalHostInfo().then(
      (info) => setHost({ state: "ready", info }),
      () => setHost({ state: "failed" }),
    );
  }, [api]);
  useEffect(load, [load]);

  const info = host.state === "ready" ? host.info : null;
  const limits = TERMINAL_LIMITS.maxRunningTerminals;
  const max = Math.min(limits.max, info?.ptyLimit ?? limits.max);

  function commitMax(): void {
    if (draft === undefined) return;
    setDraft(undefined);
    const n = parseNumber(draft, 0);
    if (n === null) return;
    const value = Math.min(max, Math.max(limits.min, n));
    if (value !== current.maxRunningTerminals) void patch({ maxRunningTerminals: value });
  }

  const showMax = settingShown(filter, "terminal.maxRunningTerminals");
  const showPs = PLATFORM === "win" && !!info?.defaultIsPowershell && settingShown(filter, "terminal.windowsPowershell");
  if (!showMax && !showPs) return null;

  return (
    <SettingGroup ids={ADVANCED_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.advanced.group")}</h4>
      {showMax && (
        <SettingRow id="terminal.maxRunningTerminals" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.terminal.advanced.maxRunning")}</span>
              <input
                type="number"
                step={1}
                min={limits.min}
                max={max}
                value={draft ?? String(current.maxRunningTerminals)}
                disabled={busy}
                data-field="maxRunningTerminals"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitMax}
                onKeyDown={(e) => e.key === "Enter" && commitMax()}
              />
              <small className="settings-hint">{t("settings.terminal.advanced.maxRunningSuffix")}</small>
              {info?.ptyLimit != null && (
                <small className="settings-hint" data-field="pty-limit">
                  {t("settings.terminal.advanced.ptyLimit", { value: info.ptyLimit })}
                </small>
              )}
              <small className="settings-hint">{t("settings.terminal.advanced.maxRunningHint")}</small>
            </label>
            {host.state === "failed" && (
              <div className="settings-actions settings-actions-start">
                <p className="error-text" role="alert" data-field="host-info-failed">
                  {t("settings.terminal.advanced.hostInfoFailed")}
                </p>
                <button type="button" className="btn-secondary" data-field="host-info-retry" onClick={load}>
                  {t("settings.terminal.advanced.retry")}
                </button>
              </div>
            )}
          </div>
        </SettingRow>
      )}
      {showPs && info && (
        <SettingRow id="terminal.windowsPowershell" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field">
              <RadioGroup
                name="terminal-windows-powershell"
                label={t("settings.terminal.advanced.powershell")}
                value={current.windowsPowershell}
                disabled={busy}
                options={POWERSHELL_CHOICES.map((value) => ({
                  value,
                  label: t(`settings.terminal.advanced.powershell.${value}`),
                  ...(value === "pwsh" && !info.pwshFound
                    ? { disabled: true, hint: t("settings.terminal.advanced.powershellMissing") }
                    : {}),
                }))}
                onChange={(value) => void patch({ windowsPowershell: value as WindowsPowershell })}
              />
              <small className="settings-hint">{t("settings.terminal.advanced.powershellHint")}</small>
              {!info.pwshFound && (
                <button
                  type="button"
                  className="btn-secondary"
                  data-field="powershell-download"
                  onClick={() => void api.openUrl(POWERSHELL_URL).catch(() => {})}
                >
                  {t("settings.terminal.advanced.powershellDownload")}
                </button>
              )}
            </div>
          </div>
        </SettingRow>
      )}
    </SettingGroup>
  );
}
