import type { Describe } from "@/api";
import type { I18n, Locale } from "@/i18n";

export type Preset = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export const PRESETS: readonly Preset[] = ["hourly", "daily", "weekdays", "weekly", "custom"];

/** What the schedule picker edits; `cron` is only read for `custom`. */
export interface ScheduleDraft {
  preset: Preset;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  dayOfWeek: number;
  cron: string;
}

export const DEFAULT_GRACE_MINUTES = 720;
export const GRACE_OPTIONS: readonly number[] = [0, 30, 60, 180, 720, 1440, 2880];
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const TIMEOUT_OPTIONS: readonly number[] = [30, 60, 120, 300, 600];

/** A new automation runs on weekdays at 9:00, like the first template. */
export const DEFAULT_DRAFT: ScheduleDraft = { preset: "weekdays", hour: 9, minute: 0, dayOfWeek: 1, cron: "" };

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAYS = "MO,TU,WE,TH,FR";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(Number.isFinite(n) ? n : lo)));

/** The stored form of a draft: an RRULE for a preset, the typed cron for `custom`. Mirrors `build_rrule` in Rust. */
export function toRrule(draft: ScheduleDraft): string {
  const hour = clamp(draft.hour, 0, 23);
  const minute = clamp(draft.minute, 0, 59);
  switch (draft.preset) {
    case "hourly":
      return `FREQ=HOURLY;BYMINUTE=${minute}`;
    case "daily":
      return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
    case "weekdays":
      return `FREQ=WEEKLY;BYDAY=${WEEKDAYS};BYHOUR=${hour};BYMINUTE=${minute}`;
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${DAY_CODES[clamp(draft.dayOfWeek, 0, 6)]};BYHOUR=${hour};BYMINUTE=${minute}`;
    case "custom":
      return draft.cron.trim();
  }
}

/** The draft a stored rule opens as. A rule that is not one of the presets opens as `custom` with its text. */
export function presetOf(rule: string): ScheduleDraft {
  const custom: ScheduleDraft = { ...DEFAULT_DRAFT, preset: "custom", cron: rule };
  const text = rule.trim().replace(/^RRULE:/i, "");
  if (!text.includes("=")) return custom;
  const part = (key: string) => new RegExp(`(?:^|;)${key}=([^;]*)`, "i").exec(text)?.[1];
  const freq = part("FREQ")?.toUpperCase();
  const whole = (v: string | undefined, fallback: number, max: number) => (v !== undefined && /^\d+$/.test(v) && Number(v) <= max ? Number(v) : fallback);
  const hour = whole(part("BYHOUR"), 9, 23);
  const minute = whole(part("BYMINUTE"), 0, 59);
  const by = part("BYDAY")?.toUpperCase();
  if (freq === "HOURLY") return { ...DEFAULT_DRAFT, preset: "hourly", minute };
  if (freq === "DAILY" && by === undefined) return { ...DEFAULT_DRAFT, preset: "daily", hour, minute };
  if (freq === "WEEKLY" && by === WEEKDAYS) return { ...DEFAULT_DRAFT, preset: "weekdays", hour, minute };
  const day = by === undefined ? -1 : DAY_CODES.indexOf(by as (typeof DAY_CODES)[number]);
  if (freq === "WEEKLY" && day >= 0) return { ...DEFAULT_DRAFT, preset: "weekly", hour, minute, dayOfWeek: day };
  return custom;
}

/** The time of day the way the locale writes it ("9:00 AM", "09:00"). */
export function formatTime(hour: number, minute: number, locale: Locale): string {
  const at = new Date(Date.UTC(2024, 0, 7, hour, minute));
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(at);
}

/** The weekday name in the locale; 0 = Sunday. */
export function dayName(dayOfWeek: number, locale: Locale): string {
  // 2024-01-07 was a Sunday.
  const at = new Date(Date.UTC(2024, 0, 7 + (((dayOfWeek % 7) + 7) % 7)));
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(at);
}

/** The label of a stored schedule: "Weekdays at 9:00 AM", "Custom schedule", "Invalid schedule". */
export function label(d: Describe, i18n: Pick<I18n, "t" | "locale">): string {
  const { t, locale } = i18n;
  switch (d.kind) {
    case "hourly":
      return t("automations.schedule.hourly", { minute: String(d.minute).padStart(2, "0") });
    case "daily":
      return t("automations.schedule.daily", { time: formatTime(d.hour, d.minute, locale) });
    case "weekdays":
      return t("automations.schedule.weekdays", { time: formatTime(d.hour, d.minute, locale) });
    case "weekly":
      return t("automations.schedule.weekly", { day: dayName(d.dayOfWeek, locale), time: formatTime(d.hour, d.minute, locale) });
    case "custom":
      return t("automations.schedule.custom");
    case "invalid":
      return t("automations.schedule.invalid");
  }
}

/** "30 minutes" style text of a grace option; the listed values have their own wording. */
export function graceLabel(minutes: number, t: I18n["t"]): string {
  return GRACE_OPTIONS.includes(minutes) ? t(`automations.grace.${minutes}`) : t("automations.grace.minutes", { count: minutes });
}
