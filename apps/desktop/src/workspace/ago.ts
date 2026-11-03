import type { useI18n } from "../i18n";

type T = ReturnType<typeof useI18n>["t"];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `ms` was at `now`, in the coarsest whole unit: "just now", "5 min", "2 h", "3 d". */
export function ago(ms: number, now: number, t: T): string {
  const age = Math.max(0, now - ms);
  if (age < MINUTE) return t("ago.now");
  if (age < HOUR) return t("ago.minutes", { count: Math.floor(age / MINUTE) });
  if (age < DAY) return t("ago.hours", { count: Math.floor(age / HOUR) });
  return t("ago.days", { count: Math.floor(age / DAY) });
}
