import type { StatusSettings } from "@/api";
import { admits } from "@/workspace/attention";
import type { Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";
import type { ActivityGroupBy, ActivityOptions } from "./options";

/** A tab with the time of its last output (null when it has had none). */
export interface ThreadSource {
  tab: Tab;
  lastOutput: number | null;
}

/** What a worktree is called and which branch it is on. */
export interface WorktreeName {
  name: string;
  branch: string | null;
}

export interface Thread {
  tab: Tab;
  worktree: string;
  worktreeName: string;
  branch: string | null;
  lastOutput: number | null;
}

export interface ThreadGroup {
  /** How the list is grouped; `none` for the one group of an ungrouped list. */
  kind: ActivityGroupBy;
  /** The group's identity: a status, a worktree path or a profile id; null for an ungrouped list. */
  key: string | null;
  /** The worktree path of a worktree group; null otherwise. */
  worktree: string | null;
  /** The worktree's name for a worktree group; null otherwise (a status or agent header is labelled by the view). */
  name: string | null;
  threads: Thread[];
}

/** The order of the status groups: what needs the person first. */
export const STATUS_ORDER: readonly TabStatus[] = ["needs-you", "failed", "working", "done", "idle", "exited"];

/** Whether any agent thread exists, idle and ended ones included: it tells "no threads" from "no match". */
export function hasAgentThreads(tabs: readonly ThreadSource[]): boolean {
  return tabs.some(({ tab }) => tab.agent);
}

const resting = (tab: Tab): boolean => tab.status === "idle" || tab.status === "exited";

/**
 * The agent threads to list: agent tabs only, idle and ended ones only with `showIdle`, filtered by
 * `query` (every word found in the title, worktree name, branch or profile, any case), newest output
 * first. The `unread` filter keeps the tabs that are unread and that `settings` admit (every unread tab
 * without `settings`). Grouped by worktree or agent, the groups keep that order, by their newest thread;
 * grouped by status they follow `STATUS_ORDER`. A group without threads is not listed.
 */
export function activityThreads(
  tabs: readonly ThreadSource[],
  names: Readonly<Record<string, WorktreeName>>,
  query: string,
  options: ActivityOptions,
  settings?: StatusSettings,
): ThreadGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const threads: Thread[] = [];
  for (const { tab, lastOutput } of tabs) {
    if (!tab.agent || (resting(tab) && !options.showIdle)) continue;
    if (options.filter === "unread" && !(tab.unread && (!settings || admits(tab.unreadReason, settings)))) continue;
    const named = names[tab.worktree];
    const thread: Thread = { tab, worktree: tab.worktree, worktreeName: named?.name ?? tab.worktree, branch: named?.branch ?? null, lastOutput };
    const hay = [tab.title ?? "", thread.worktreeName, thread.branch ?? "", tab.profileId].join("\n").toLowerCase();
    if (words.every((w) => hay.includes(w))) threads.push(thread);
  }
  // Array.sort is stable, so equal times keep the order the tabs came in.
  threads.sort((a, b) => (b.lastOutput ?? 0) - (a.lastOutput ?? 0));
  if (threads.length === 0) return [];
  if (options.groupBy === "none") return [{ kind: "none", key: null, worktree: null, name: null, threads }];
  const groups = new Map<string, ThreadGroup>();
  for (const thread of threads) {
    const key = options.groupBy === "status" ? thread.tab.status : options.groupBy === "agent" ? thread.tab.profileId : thread.worktree;
    let group = groups.get(key);
    if (!group) {
      const worktree = options.groupBy === "worktree";
      groups.set(key, (group = { kind: options.groupBy, key, worktree: worktree ? thread.worktree : null, name: worktree ? thread.worktreeName : null, threads: [] }));
    }
    group.threads.push(thread);
  }
  const list = [...groups.values()];
  if (options.groupBy === "status") list.sort((a, b) => STATUS_ORDER.indexOf(a.key as TabStatus) - STATUS_ORDER.indexOf(b.key as TabStatus));
  return list;
}
