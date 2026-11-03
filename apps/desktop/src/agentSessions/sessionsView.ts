import type { SessionRow, SessionSort } from "@/api";

export type DayGroup = { id: string; kind: "today" | "yesterday" | "date"; /** Start of that local day, ms. */ at: number; rows: SessionRow[] };

const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** The last folder of a path, with either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? "";
}

/**
 * Rows in their given order, split where the local day changes: by the last activity, or by the start
 * when sorted by it. A row with no time (0) goes under the date of 1 Jan 1970.
 */
export function groupByDay(rows: SessionRow[], sort: SessionSort, now: number): DayGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const at = dayStart(sort === "firstDesc" ? row.session.first : row.session.last);
    const kind = at === today ? "today" : at === yesterday ? "yesterday" : "date";
    const tail = groups.at(-1);
    if (tail && tail.at === at) tail.rows.push(row);
    else groups.push({ id: `${kind}:${at}`, kind, at, rows: [row] });
  }
  return groups;
}
