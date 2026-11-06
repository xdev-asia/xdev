import { useState } from "react";
import type { JSX } from "react";
import type { TerminalBell, TerminalLinkClick } from "@/api";
import { useI18n } from "@/i18n";
import { PLATFORM } from "@/platform";
import { DEFAULT_WORD_SEPARATORS } from "@/settings/terminalDefaults";
import { TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { SettingGroup, SettingRow, settingShown } from "../SettingRow";
import { parseNumber, type TerminalSectionProps } from "./sectionProps";

export const BELL_MODES: TerminalBell[] = ["none", "visual", "sound"];
export const LINK_CLICK_MODES: TerminalLinkClick[] = ["actions", "open", "none"];
const LINK_IDS = ["terminal.linkClick", "terminal.urlMiddleClick"];
const INTERACTION_IDS = [
  "terminal.scrollSensitivity",
  "terminal.fastScrollSensitivity",
  "terminal.focusFollowsMouse",
  "terminal.middleClickPaste",
  "terminal.shellIntegration",
];
const BELL_IDS = ["terminal.bell"];
const WORD_IDS = ["terminal.wordSeparators"];
type SpeedField = "scrollSensitivity" | "fastScrollSensitivity";

/** Settings → Terminal → Interaction, Links, Bell and Word separators. */
export function TerminalBehaviourSection(props: TerminalSectionProps): JSX.Element {
  const { current, busy, patch, filter } = props;
  const { t } = useI18n();
  // Fields while they are being typed in; written on blur or Enter.
  const [speed, setSpeed] = useState<Partial<Record<SpeedField, string>>>({});
  const [words, setWords] = useState<string | undefined>(undefined);

  function commitSpeed(field: SpeedField): void {
    const raw = speed[field];
    if (raw === undefined) return;
    const rest = { ...speed };
    delete rest[field];
    setSpeed(rest);
    const value = parseNumber(raw, 2);
    if (value === null || value === current[field]) return;
    void patch({ [field]: value });
  }
  const speedInput = (field: SpeedField, step: number) => (
    <input
      type="number"
      step={step}
      min={TERMINAL_LIMITS[field].min}
      max={TERMINAL_LIMITS[field].max}
      value={speed[field] ?? String(current[field])}
      disabled={busy}
      data-field={field}
      onChange={(e) => setSpeed((s) => ({ ...s, [field]: e.target.value }))}
      onBlur={() => commitSpeed(field)}
      onKeyDown={(e) => e.key === "Enter" && commitSpeed(field)}
    />
  );

  // An empty list reads as the default, so it is written as the default.
  function commitWords(): void {
    if (words === undefined) return;
    const value = words === "" ? DEFAULT_WORD_SEPARATORS : words;
    setWords(undefined);
    if (value === current.wordSeparators) return;
    void patch({ wordSeparators: value });
  }
  const shownWords = words ?? current.wordSeparators;

  return (
    <>
      <SettingGroup ids={INTERACTION_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.interaction.group")}</h4>
        <div className="ws-fields">
          <SettingRow id="terminal.scrollSensitivity" filter={filter}>
            <label className="ws-field">
              <span>{t("settings.terminal.interaction.scroll")}</span>
              {speedInput("scrollSensitivity", 0.05)}
            </label>
          </SettingRow>
          <SettingRow id="terminal.fastScrollSensitivity" filter={filter}>
            <label className="ws-field">
              <span>{t("settings.terminal.interaction.fastScroll")}</span>
              {speedInput("fastScrollSensitivity", 0.5)}
            </label>
          </SettingRow>
        </div>
        <ul className="settings-list">
          {settingShown(filter, "terminal.focusFollowsMouse") && (
            <li className="settings-item" data-switch="focusFollowsMouse" data-setting-id="terminal.focusFollowsMouse">
              <div className="settings-item-text">
                <strong>{t("settings.terminal.interaction.focusFollowsMouse")}</strong>
                <span className="settings-path">{t("settings.terminal.interaction.focusFollowsMouseHint")}</span>
              </div>
              <button
                type="button"
                role="switch"
                className="agent-switch"
                aria-checked={current.focusFollowsMouse}
                aria-label={t("settings.terminal.interaction.focusFollowsMouse")}
                disabled={busy}
                onClick={() => void patch({ focusFollowsMouse: !current.focusFollowsMouse })}
              />
            </li>
          )}
          {PLATFORM === "linux" && settingShown(filter, "terminal.middleClickPaste") && (
            <li className="settings-item" data-switch="middleClickPaste" data-setting-id="terminal.middleClickPaste">
              <div className="settings-item-text">
                <strong>{t("settings.terminal.interaction.middleClickPaste")}</strong>
                <span className="settings-path">{t("settings.terminal.interaction.middleClickPasteHint")}</span>
              </div>
              <button
                type="button"
                role="switch"
                className="agent-switch"
                aria-checked={current.middleClickPaste}
                aria-label={t("settings.terminal.interaction.middleClickPaste")}
                disabled={busy}
                onClick={() => void patch({ middleClickPaste: !current.middleClickPaste })}
              />
            </li>
          )}
          {settingShown(filter, "terminal.shellIntegration") && (
            <li className="settings-item" data-switch="shellIntegration" data-setting-id="terminal.shellIntegration">
              <div className="settings-item-text">
                <strong>{t("settings.terminal.interaction.shellIntegration")}</strong>
                <span className="settings-path">{t("settings.terminal.interaction.shellIntegrationHint")}</span>
              </div>
              <button
                type="button"
                role="switch"
                className="agent-switch"
                aria-checked={current.shellIntegration}
                aria-label={t("settings.terminal.interaction.shellIntegration")}
                disabled={busy}
                onClick={() => void patch({ shellIntegration: !current.shellIntegration })}
              />
            </li>
          )}
        </ul>
      </SettingGroup>

      <SettingGroup ids={LINK_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.links.group")}</h4>
        <SettingRow id="terminal.linkClick" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" role="radiogroup" aria-label={t("settings.terminal.links.click")}>
              <span>{t("settings.terminal.links.click")}</span>
              <div className="term-radios">
                {LINK_CLICK_MODES.map((m) => (
                  <label key={m} className="term-radio">
                    <input
                      type="radio"
                      name="terminal-link-click"
                      value={m}
                      checked={current.linkClick === m}
                      disabled={busy}
                      data-link-click={m}
                      onChange={() => void patch({ linkClick: m })}
                    />
                    {t(`settings.terminal.links.${m}`)}
                  </label>
                ))}
              </div>
              <small className="settings-hint">{t("settings.terminal.links.hint")}</small>
            </div>
          </div>
        </SettingRow>
        <SettingRow id="terminal.urlMiddleClick" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" role="radiogroup" aria-label={t("settings.terminal.links.middleClick")}>
              <span>{t("settings.terminal.links.middleClick")}</span>
              <div className="term-radios">
                {LINK_CLICK_MODES.map((m) => (
                  <label key={m} className="term-radio">
                    <input
                      type="radio"
                      name="terminal-url-middle-click"
                      value={m}
                      checked={current.urlMiddleClick === m}
                      disabled={busy}
                      data-url-middle-click={m}
                      onChange={() => void patch({ urlMiddleClick: m })}
                    />
                    {t(`settings.terminal.links.${m}`)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup ids={BELL_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.bell.group")}</h4>
        <SettingRow id="terminal.bell" filter={filter}>
          <div className="ws-fields">
            <div className="ws-field" role="radiogroup" aria-label={t("settings.terminal.bell.label")}>
              <span>{t("settings.terminal.bell.label")}</span>
              <div className="term-radios">
                {BELL_MODES.map((m) => (
                  <label key={m} className="term-radio">
                    <input
                      type="radio"
                      name="terminal-bell"
                      value={m}
                      checked={current.bell === m}
                      disabled={busy}
                      data-bell={m}
                      onChange={() => void patch({ bell: m })}
                    />
                    {t(`settings.terminal.bell.${m}`)}
                  </label>
                ))}
              </div>
              <small className="settings-hint">{t("settings.terminal.bell.hint")}</small>
            </div>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup ids={WORD_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.words.group")}</h4>
        <SettingRow id="terminal.wordSeparators" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.terminal.words.label")}</span>
              <input
                type="text"
                className="ws-mono"
                value={shownWords}
                disabled={busy}
                spellCheck={false}
                data-field="wordSeparators"
                onChange={(e) => setWords(e.target.value)}
                onBlur={commitWords}
                onKeyDown={(e) => e.key === "Enter" && commitWords()}
              />
              {!shownWords.includes(" ") && (
                <small className="settings-hint" data-field="words-hint">
                  {t("settings.terminal.words.hint")}
                </small>
              )}
            </label>
            {current.wordSeparators !== DEFAULT_WORD_SEPARATORS && (
              <div className="settings-actions settings-actions-start">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  data-field="words-reset"
                  onClick={() => {
                    setWords(undefined);
                    void patch({ wordSeparators: DEFAULT_WORD_SEPARATORS });
                  }}
                >
                  {t("settings.terminal.words.reset")}
                </button>
              </div>
            )}
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
