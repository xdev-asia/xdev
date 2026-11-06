import { useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { loadRemindDays, REMIND_DAYS, saveRemindDays } from "@/shell/updateNudge";

/** Settings → General → Updates: how long "Remind me later" waits before the update card returns. */
export function UpdateReminderSetting(): JSX.Element {
  const { t } = useI18n();
  const [days, setDays] = useState(() => loadRemindDays());
  return (
    <div className="ws-fields">
      <label className="ws-field">
        <span>{t("settings.general.updates.remind")}</span>
        <select
          value={days}
          data-field="update-remind"
          onChange={(e) => {
            const n = Number(e.target.value);
            saveRemindDays(n);
            setDays(n);
          }}
        >
          {REMIND_DAYS.map((d) => (
            <option key={d} value={d}>
              {t(`settings.general.updates.remind.${d}`)}
            </option>
          ))}
        </select>
        <small className="settings-hint">{t("settings.general.updates.remindHint")}</small>
      </label>
    </div>
  );
}
