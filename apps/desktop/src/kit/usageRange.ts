import { dayRange, localDay } from "./kitUi";

export type UsageRange = "7" | "30" | "90" | "all";

/** Local `YYYY-MM-DD` days of a range ending today; All time has no start. */
export function rangeDays(range: UsageRange, now: Date): { sinceDay: string | null; untilDay: string } {
  if (range === "all") return { sinceDay: null, untilDay: localDay(now) };
  const [sinceDay, untilDay] = dayRange(Number(range), now);
  return { sinceDay, untilDay };
}
