import type { Automation, AutomationRun } from "@/api";
import type { I18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import type { RunTone } from "./runModel";

type T = I18n["t"];

/** A search longer than this is ignored. */
export const SEARCH_MAX = 256;

export type LastRunFilter = "all" | "succeeded" | "failed" | "never";
export type SortKey = "name" | "lastRun";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

export interface ListQuery {
  search: string;
  /** An agent profile id; null for every agent. */
  agent: string | null;
  lastRun: LastRunFilter;
  sort: Sort | null;
}

export const NO_QUERY: ListQuery = { search: "", agent: null, lastRun: "all", sort: null };

export interface Row {
  automation: Automation;
  lastRun: AutomationRun | null;
  project: string;
}

export interface Visible {
  rows: Row[];
  /** The search was too long and left out. */
  tooLong: boolean;
  /** Search or a filter is on. */
  filtered: boolean;
  /** Only a filter (not the search) is on. */
  filtersOn: boolean;
}

/** `succeeded` is a completed last run, `failed` a failed one; skipped and running runs are in neither. */
export type Bucket = "never" | "succeeded" | "failed" | "skipped" | "running";

export function bucketOf(run: AutomationRun | null): Bucket {
  if (!run) return "never";
  switch (run.status) {
    case "completed":
      return "succeeded";
    case "dispatch_failed":
      return "failed";
    case "pending":
    case "dispatching":
    case "dispatched":
      return "running";
    default:
      return "skipped";
  }
}

export function filtersActive(q: ListQuery): boolean {
  return q.agent !== null || q.lastRun !== "all";
}

/** Search (name, prompt, project), filters and sort. Search is case-insensitive and ignored past `SEARCH_MAX`. */
export function visibleRows(automations: readonly Automation[], lastRuns: readonly AutomationRun[], projectName: (repoId: string) => string, q: ListQuery): Visible {
  const byAutomation = new Map(lastRuns.map((r) => [r.automationId, r]));
  const tooLong = q.search.length > SEARCH_MAX;
  const needle = tooLong ? "" : q.search.trim().toLowerCase();
  let rows: Row[] = automations.map((automation) => ({ automation, lastRun: byAutomation.get(automation.id) ?? null, project: projectName(automation.repoId) }));
  if (needle) rows = rows.filter((r) => [r.automation.name, r.automation.prompt, r.project].some((s) => s.toLowerCase().includes(needle)));
  if (q.agent !== null) rows = rows.filter((r) => r.automation.agent === q.agent);
  if (q.lastRun !== "all") rows = rows.filter((r) => bucketOf(r.lastRun) === q.lastRun || (q.lastRun === "never" && r.lastRun === null));
  if (q.sort) {
    const { key, dir } = q.sort;
    const sign = dir === "asc" ? 1 : -1;
    const stamp = (r: Row) => r.lastRun?.createdAt ?? -1;
    rows = [...rows].sort((a, b) => sign * (key === "name" ? a.automation.name.localeCompare(b.automation.name, undefined, { sensitivity: "base" }) : stamp(a) - stamp(b)) || a.automation.name.localeCompare(b.automation.name));
  }
  return { rows, tooLong, filtered: needle !== "" || filtersActive(q), filtersOn: filtersActive(q) };
}

/** Header click: ascending, then descending, then the stored order. */
export function nextSort(current: Sort | null, key: SortKey): Sort | null {
  if (current?.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

/** `{column}, sorted ascending` for the header's `aria-label`; null while the column is not sorted. */
export function sortLabel(current: Sort | null, key: SortKey, column: string, t: T): string | null {
  if (current?.key !== key) return null;
  return t(current.dir === "asc" ? "automations.list.sort.asc" : "automations.list.sort.desc", { column });
}

/** The last-run cell: `Done 5 min`, `Failed 2 h`, `Never`. */
export function lastRunCell(run: AutomationRun | null, now: number, t: T): { tone: RunTone; text: string } {
  const when = (r: AutomationRun) => ago(r.finishedAt ?? r.createdAt, now, t);
  switch (bucketOf(run)) {
    case "never":
      return { tone: "idle", text: t("automations.list.lastRun.never") };
    case "succeeded":
      return { tone: "done", text: t("automations.list.lastRun.done", { ago: when(run!) }) };
    case "failed":
      return { tone: "failed", text: t("automations.list.lastRun.failed", { ago: when(run!) }) };
    case "running":
      return { tone: "working", text: t("automations.list.lastRun.running", { ago: when(run!) }) };
    case "skipped":
      return { tone: "idle", text: t("automations.list.lastRun.skipped", { ago: when(run!) }) };
  }
}
