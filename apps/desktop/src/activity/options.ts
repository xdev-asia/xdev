/** What the Activity view shows; kept on this computer. */
export interface ActivityOptions {
  /** Threads that are idle or ended show too. */
  showIdle: boolean;
  /** Threads are grouped under their worktree. */
  groupByWorktree: boolean;
}

export const ACTIVITY_OPTIONS_KEY = "xdev.activity.options";
export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = { showIdle: false, groupByWorktree: false };

/** The saved options; the defaults when nothing is saved, the text is not JSON, or storage cannot be read. */
export function loadActivityOptions(): ActivityOptions {
  try {
    const raw = localStorage.getItem(ACTIVITY_OPTIONS_KEY);
    if (raw === null) return { ...DEFAULT_ACTIVITY_OPTIONS };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...DEFAULT_ACTIVITY_OPTIONS };
    const o = value as Record<string, unknown>;
    return {
      showIdle: typeof o.showIdle === "boolean" ? o.showIdle : DEFAULT_ACTIVITY_OPTIONS.showIdle,
      groupByWorktree: typeof o.groupByWorktree === "boolean" ? o.groupByWorktree : DEFAULT_ACTIVITY_OPTIONS.groupByWorktree,
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
