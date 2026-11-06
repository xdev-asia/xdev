import { Switch } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { setTipsEnabled, useTipsEnabled } from "./tipsStore";

/** Settings → General: turns the startup tips on or back on. */
export function TipsSetting(): JSX.Element {
  const { t } = useI18n();
  const on = useTipsEnabled();
  return (
    <ul className="settings-list">
      <li className="settings-item" data-switch="tips">
        <div className="settings-item-text">
          <strong>{t("settings.general.tips")}</strong>
          <small className="settings-hint">{t("settings.general.tipsHint")}</small>
        </div>
        <Switch aria-label={t("settings.general.tips")} checked={on} onChange={() => setTipsEnabled(!on)} />
      </li>
    </ul>
  );
}
