export type ActivityGroupBy = "none" | "status" | "worktree" | "agent";
export type ActivityFilter = "all" | "unread";

const GROUPS: readonly ActivityGroupBy[] = ["none", "status", "worktree", "agent"];
const FILTERS: readonly ActivityFilter[] = ["all", "unread"];

/** What the Activity view shows; kept on this computer. */
export interface ActivityOptions {
  /** Threads that are idle or ended show too. */
  showIdle: boolean;
  /** How the threads are grouped under headers. */
  groupBy: ActivityGroupBy;
  /** Every thread, or only the unread ones. */
  filter: ActivityFilter;
  /** One line per row, without the meta line. */
  compact: boolean;
}

export const ACTIVITY_OPTIONS_KEY = "xdev.activity.options";
export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = { showIdle: false, groupBy: "none", filter: "all", compact: false };

/**
 * The saved options; the defaults when nothing is saved, the text is not JSON, or storage cannot be read.
 * The old boolean `groupByWorktree: true` reads as `groupBy: "worktree"`.
 */
export function loadActivityOptions(): ActivityOptions {
  try {
    const raw = localStorage.getItem(ACTIVITY_OPTIONS_KEY);
    if (raw === null) return { ...DEFAULT_ACTIVITY_OPTIONS };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...DEFAULT_ACTIVITY_OPTIONS };
    const o = value as Record<string, unknown>;
    const groupBy = GROUPS.find((g) => g === o.groupBy) ?? (o.groupByWorktree === true ? "worktree" : DEFAULT_ACTIVITY_OPTIONS.groupBy);
    return {
      showIdle: typeof o.showIdle === "boolean" ? o.showIdle : DEFAULT_ACTIVITY_OPTIONS.showIdle,
      groupBy,
      filter: FILTERS.find((f) => f === o.filter) ?? DEFAULT_ACTIVITY_OPTIONS.filter,
      compact: typeof o.compact === "boolean" ? o.compact : DEFAULT_ACTIVITY_OPTIONS.compact,
    };
  } catch {
    return { ...DEFAULT_ACTIVITY_OPTIONS };
  }
}

export function saveActivityOptions(options: ActivityOptions): void {
  try {
    localStorage.setItem(ACTIVITY_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // The choice only fails to survive a restart.
  }
}
