import { useState } from "react";
import type { JSX } from "react";
import type { FontWeightBold } from "@/api";
import { useI18n } from "@/i18n";
import { TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { SettingGroup, SettingRow, settingShown } from "../SettingRow";
import { parseNumber, type TerminalSectionProps } from "./sectionProps";

export const BOLD_WEIGHTS: FontWeightBold[] = ["bold", "600", "700"];
const TEXT_IDS = ["terminal.fontWeightBold", "terminal.scrollOnInput"];
const SPACE_IDS = ["terminal.paddingPx", "terminal.backgroundOpacity"];
const PANE_IDS = ["terminal.dimInactivePanes", "terminal.paneDividerPx"];
type NumberField = "paddingPx" | "backgroundOpacity" | "paneDividerPx";

/** Settings → Terminal → Text, Spacing and Panes. */
export function TerminalAppearanceSection(props: TerminalSectionProps): JSX.Element {
  const { current, busy, patch, filter } = props;
  const { t } = useI18n();
  // A number while it is being typed in; written on blur or Enter.
  const [draft, setDraft] = useState<Partial<Record<NumberField, string>>>({});

  function commit(field: NumberField, places: number): void {
    const raw = draft[field];
    if (raw === undefined) return;
    const value = parseNumber(raw, places);
    setDraft((d) => {
      const rest = { ...d };
      delete rest[field];
      return rest;
    });
    if (value === null || value === current[field]) return;
    void patch({ [field]: value });
  }
  const numberInput = (field: NumberField, step: number, places: number) => (
    <input
      type="number"
      step={step}
      min={TERMINAL_LIMITS[field].min}
      max={TERMINAL_LIMITS[field].max}
      value={draft[field] ?? String(current[field])}
      disabled={busy}
      data-field={field}
      onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
      onBlur={() => commit(field, places)}
      onKeyDown={(e) => e.key === "Enter" && commit(field, places)}
    />
  );
  const toggle = (id: string, field: "scrollOnInput" | "dimInactivePanes", label: string, hint?: string) =>
    settingShown(filter, id) && (
      <li className="settings-item" data-switch={field} data-setting-id={id}>
        <div className="settings-item-text">
          <strong>{label}</strong>
          {hint && <small className="settings-hint">{hint}</small>}
        </div>
        <button
          type="button"
          role="switch"
          className="agent-switch"
          aria-checked={current[field]}
          aria-label={label}
          disabled={busy}
          onClick={() => void patch({ [field]: !current[field] })}
        />
      </li>
    );

  return (
    <>
      <SettingGroup ids={TEXT_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.text.group")}</h4>
        <SettingRow id="terminal.fontWeightBold" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.terminal.text.boldWeight")}</span>
              <select
                value={current.fontWeightBold}
                disabled={busy}
                data-field="fontWeightBold"
                onChange={(e) => void patch({ fontWeightBold: e.target.value as FontWeightBold })}
              >
                {BOLD_WEIGHTS.map((w) => (
                  <option key={w} value={w}>
                    {t(`settings.terminal.text.boldWeight.${w}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </SettingRow>
        <ul className="settings-list">
          {toggle("terminal.scrollOnInput", "scrollOnInput", t("settings.terminal.text.scrollOnInput"), t("settings.terminal.text.scrollOnInputHint"))}
        </ul>
      </SettingGroup>

      <SettingGroup ids={SPACE_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.space.group")}</h4>
        <div className="ws-fields">
          <SettingRow id="terminal.paddingPx" filter={filter}>
            <label className="ws-field">
              <span>{t("settings.terminal.space.padding")}</span>
              {numberInput("paddingPx", 1, 0)}
            </label>
          </SettingRow>
          <SettingRow id="terminal.backgroundOpacity" filter={filter}>
            <label className="ws-field">
              <span>{t("settings.terminal.space.opacity")}</span>
              {numberInput("backgroundOpacity", 0.05, 2)}
              <small className="settings-hint">{t("settings.terminal.space.opacityHint")}</small>
            </label>
          </SettingRow>
        </div>
      </SettingGroup>

      <SettingGroup ids={PANE_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.terminal.panes.group")}</h4>
        <ul className="settings-list">
          {toggle("terminal.dimInactivePanes", "dimInactivePanes", t("settings.terminal.panes.dim"), t("settings.terminal.panes.dimHint"))}
        </ul>
        <SettingRow id="terminal.paneDividerPx" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.terminal.panes.divider")}</span>
              {numberInput("paneDividerPx", 1, 0)}
            </label>
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
