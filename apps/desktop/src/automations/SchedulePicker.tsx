import type { JSX } from "react";
import { Select } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { CustomCronPanel } from "./CustomCronPanel";
import { PRESETS, dayName, type Preset, type ScheduleDraft } from "./schedule";

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` of an `<input type="time">`, back to hour and minute; null for a partial value. */
export function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** The schedule: a cadence, then the time, minute or day it needs, or the custom cron panel. */
export function SchedulePicker(props: {
  draft: ScheduleDraft;
  onChange(draft: ScheduleDraft): void;
  cronError: string | null;
  timezone: string;
}): JSX.Element {
  const { t, locale } = useI18n();
  const { draft, onChange } = props;
  const timed = draft.preset === "daily" || draft.preset === "weekdays" || draft.preset === "weekly";
  return (
    <div className="au-schedule" role="group" aria-label={t("automations.schedule.label")}>
      <label className="ws-field">
        <span>{t("automations.schedule.cadence")}</span>
        <Select
          value={draft.preset}
          data-act="cadence"
          options={PRESETS.map((p) => ({ value: p, label: t(`automations.schedule.preset.${p}`) }))}
          onChange={(e) => onChange({ ...draft, preset: e.target.value as Preset })}
        />
      </label>
      {draft.preset === "hourly" && (
        <label className="ws-field">
          <span>{t("automations.schedule.minute")}</span>
          <Select
            value={String(draft.minute)}
            data-act="minute"
            options={Array.from({ length: 60 }, (_, m) => ({ value: String(m), label: `:${pad(m)}` }))}
            onChange={(e) => onChange({ ...draft, minute: Number(e.target.value) })}
          />
        </label>
      )}
      {draft.preset === "weekly" && (
        <label className="ws-field">
          <span>{t("automations.schedule.day")}</span>
          <Select
            value={String(draft.dayOfWeek)}
            data-act="day"
            options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: dayName(d, locale) }))}
            onChange={(e) => onChange({ ...draft, dayOfWeek: Number(e.target.value) })}
          />
        </label>
      )}
      {timed && (
        <label className="ws-field">
          <span>{t("automations.schedule.time")}</span>
          <input
            type="time"
            data-act="time"
            value={`${pad(draft.hour)}:${pad(draft.minute)}`}
            onChange={(e) => {
              const time = parseTime(e.target.value);
              if (time) onChange({ ...draft, ...time });
            }}
          />
        </label>
      )}
      {draft.preset === "custom" && <CustomCronPanel cron={draft.cron} error={props.cronError} onChange={(cron) => onChange({ ...draft, cron })} />}
      <p className="au-sub">{t("automations.schedule.timezone", { zone: props.timezone })}</p>
    </div>
  );
}
