import type { Agent, SessionRow, SessionSort } from "@/api";

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

export type GroupBy = "day" | "folder" | "agent";
/** How far back the list reaches, in days by the last activity; `null` is no limit. */
export type HistoryDays = 7 | 30 | 90 | null;

export const GROUP_BYS: readonly GroupBy[] = ["day", "folder", "agent"];
export const HISTORY_DAYS: readonly HistoryDays[] = [7, 30, 90, null];

export type SessionGroup =
  | { id: string; kind: "today" | "yesterday" | "date"; at: number; rows: SessionRow[] }
  | { id: string; kind: "folder"; /** The full path, or "" for a session with no folder. */ path: string; rows: SessionRow[] }
  | { id: string; kind: "agent"; agent: Agent; rows: SessionRow[] };

const AGENTS: readonly Agent[] = ["claude", "codex"];
const DAY_MS = 86_400_000;

/** Rows whose last activity is within `days` days of `now`; all of them when `days` is null. */
export function withinHistory(rows: SessionRow[], days: HistoryDays, now: number): SessionRow[] {
  if (days === null) return rows;
  const since = dayStart(now) - (days - 1) * DAY_MS;
  return rows.filter((r) => r.session.last >= since);
}

/** The folder a row belongs to: its worktree when the registry knows it, else the session's folder. */
export const folderOf = (row: SessionRow): string => row.worktree ?? row.session.cwd ?? "";

/** Rows split by folder, in the order each folder first appears. */
export function groupByFolder(rows: SessionRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup & { kind: "folder" }>();
  for (const row of rows) {
    const path = folderOf(row);
    const group = groups.get(path) ?? { id: `folder:${path}`, kind: "folder" as const, path, rows: [] };
    group.rows.push(row);
    groups.set(path, group);
  }
  return [...groups.values()];
}

/** Rows split by agent: every agent in a fixed order, so an agent with no row is an empty group. */
export function groupByAgent(rows: SessionRow[]): SessionGroup[] {
  return AGENTS.map((agent) => ({ id: `agent:${agent}`, kind: "agent" as const, agent, rows: rows.filter((r) => r.session.agent === agent) }));
}

export interface GroupOptions {
  by: GroupBy;
  sort: SessionSort;
  now: number;
  history: HistoryDays;
  hideEmpty: boolean;
}

/**
 * The panel's groups: the depth filter first, then the split. Folders that only have older rows stay
 * as empty groups, and so do Today and Yesterday, unless `hideEmpty` drops every group with no row.
 */
export function groupRows(rows: SessionRow[], o: GroupOptions): SessionGroup[] {
  const kept = withinHistory(rows, o.history, o.now);
  let groups: SessionGroup[];
  if (o.by === "day") {
    groups = groupByDay(kept, o.sort, o.now);
    const today = dayStart(o.now);
    const yesterday = dayStart(today - 1);
    // The two named days always have a header, so a quiet day reads as empty, not as missing.
    if (!groups.some((g) => g.kind === "today")) groups.unshift({ id: `today:${today}`, kind: "today", at: today, rows: [] });
    if (!groups.some((g) => g.kind === "yesterday")) groups.splice(1, 0, { id: `yesterday:${yesterday}`, kind: "yesterday", at: yesterday, rows: [] });
  } else if (o.by === "folder") {
    const all = groupByFolder(rows);
    const have = new Map(groupByFolder(kept).map((g) => [g.id, g]));
    groups = all.map((g) => have.get(g.id) ?? { ...g, rows: [] });
  } else {
    groups = groupByAgent(kept);
  }
  return o.hideEmpty ? groups.filter((g) => g.rows.length > 0) : groups;
}
