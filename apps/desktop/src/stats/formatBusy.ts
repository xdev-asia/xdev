type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A time as days with hours, hours with minutes, or minutes; zero, negative and non-finite times show 0m. */
export function formatBusy(ms: number, t: Translate): string {
  if (!Number.isFinite(ms) || ms <= 0) return t("usage.app.dur.minutes", { m: 0 });
  const days = Math.floor(ms / DAY);
  if (days > 0) return t("usage.app.dur.days", { d: days, h: Math.floor((ms % DAY) / HOUR) });
  const hours = Math.floor(ms / HOUR);
  if (hours > 0) return t("usage.app.dur.hours", { h: hours, m: Math.floor((ms % HOUR) / MINUTE) });
  return t("usage.app.dur.minutes", { m: Math.floor(ms / MINUTE) });
}
