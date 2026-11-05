import type { SessionState } from "@xdev-asia/ui";
import type { TabStatus } from "@/workspace/status";
import type { Thread, ThreadSource, WorktreeName } from "./threads";

export type DashboardBucket = "attention" | "working" | "done";

export interface DashboardRow {
  thread: Thread;
  bucket: DashboardBucket;
  /** The status dot state for the row. */
  dot: SessionState;
  /** What a dismissal is keyed by: the tab and its status, so a new status brings the row back. */
  key: string;
}

export const dismissKey = (tabId: string, status: string): string => `${tabId}:${status}`;

const ORDER: readonly DashboardBucket[] = ["attention", "working", "done"];

const BUCKET: Partial<Record<TabStatus, DashboardBucket>> = {
  "needs-you": "attention",
  failed: "attention",
  working: "working",
  done: "done",
};

const DOT: Partial<Record<TabStatus, SessionState>> = {
  "needs-you": "waiting",
  failed: "failed",
  working: "working",
  done: "done",
};

/** The status dot state for a tab status; idle and ended tabs have no dashboard row. */
export function dotState(status: TabStatus): SessionState | null {
  return DOT[status] ?? null;
}

/**
 * The agent dashboard rows in three groups: needs you (needs-you, failed), working, done. Idle and
 * ended tabs and plain shells are left out, as are dismissed rows and empty groups. Newest output first.
 */
export function dashboardBuckets(
  sources: readonly ThreadSource[],
  names: Readonly<Record<string, WorktreeName>>,
  dismissed: ReadonlySet<string>,
): { bucket: DashboardBucket; rows: DashboardRow[] }[] {
  const rows = new Map<DashboardBucket, DashboardRow[]>();
  for (const { tab, lastOutput } of sources) {
    const bucket = BUCKET[tab.status];
    const dot = DOT[tab.status];
    if (!tab.agent || !bucket || !dot) continue;
    const key = dismissKey(tab.id, tab.status);
    if (dismissed.has(key)) continue;
    const named = names[tab.worktree];
    const thread: Thread = { tab, worktree: tab.worktree, worktreeName: named?.name ?? tab.worktree, branch: named?.branch ?? null, lastOutput };
    const list = rows.get(bucket) ?? [];
    list.push({ thread, bucket, dot, key });
    rows.set(bucket, list);
  }
  return ORDER.flatMap((bucket) => {
    const list = rows.get(bucket);
    if (!list) return [];
    // Array.sort is stable, so equal times keep the order the tabs came in.
    list.sort((a, b) => (b.thread.lastOutput ?? 0) - (a.thread.lastOutput ?? 0));
    return [{ bucket, rows: list }];
  });
}
