import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Segmented } from "@xdev-asia/ui";
import type { MacOptionAsAlt } from "@/api";
import { useI18n } from "@/i18n";
import { IS_MAC } from "@/platform";
import { getDetectedLayout, subscribeDetectedLayout, type DetectedLayout } from "@/terminal/optionAsAlt";
import { SettingGroup, SettingRow } from "../SettingRow";
import type { TerminalSectionProps } from "./sectionProps";

export const OPTION_MODES: readonly MacOptionAsAlt[] = ["auto", "both", "left", "right", "off"];
const KEYBOARD_IDS = ["terminal.optionAsAlt"];

/** The i18n key and variables of the line that says what the chosen mode does now. */
export function optionStateText(mode: MacOptionAsAlt, layout: DetectedLayout): { key: string; layoutKey?: string } {
  return mode === "auto"
    ? { key: "settings.terminal.keyboard.state.auto", layoutKey: `settings.terminal.keyboard.layout.${layout}` }
    : { key: `settings.terminal.keyboard.state.${mode}` };
}

/** Settings → Terminal → Keyboard: Option as Alt. macOS only. */
export function TerminalKeyboardSection(props: TerminalSectionProps): JSX.Element | null {
  const { current, busy, patch, filter } = props;
  const { t } = useI18n();
  const [layout, setLayout] = useState<DetectedLayout>(getDetectedLayout);
  useEffect(() => {
    setLayout(getDetectedLayout());
    return subscribeDetectedLayout(() => setLayout(getDetectedLayout()));
  }, []);
  if (!IS_MAC) return null;
  const state = optionStateText(current.macOptionAsAlt, layout);
  return (
    <SettingGroup ids={KEYBOARD_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.keyboard.group")}</h4>
      <SettingRow id="terminal.optionAsAlt" filter={filter}>
        <div className="ws-fields">
          <div className="ws-field settings-option-modes">
            <span>{t("settings.terminal.keyboard.optionAsAlt")}</span>
            <Segmented
              label={t("settings.terminal.keyboard.optionAsAlt")}
              options={OPTION_MODES.map((value) => ({ value, label: t(`settings.terminal.keyboard.mode.${value}`) }))}
              value={current.macOptionAsAlt}
              onChange={(value) => {
                if (!busy) void patch({ macOptionAsAlt: value as MacOptionAsAlt });
              }}
            />
          </div>
        </div>
        <p className="settings-hint">{t("settings.terminal.keyboard.optionAsAltHint")}</p>
        <p className="settings-hint" data-option-state={current.macOptionAsAlt}>
          {state.layoutKey ? t(state.key, { layout: t(state.layoutKey) }) : t(state.key)}
        </p>
        <p className="settings-hint">{t("settings.terminal.keyboard.choose")}</p>
      </SettingRow>
    </SettingGroup>
  );
}
