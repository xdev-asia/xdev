import type { Tab } from "@/workspace/sessions";
import type { ActivityOptions } from "./options";

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
  /** The worktree path; null for the one group of an ungrouped list. */
  worktree: string | null;
  name: string | null;
  threads: Thread[];
}

/** Whether any agent thread exists, idle and ended ones included: it tells "no threads" from "no match". */
export function hasAgentThreads(tabs: readonly ThreadSource[]): boolean {
  return tabs.some(({ tab }) => tab.agent);
}

const resting = (tab: Tab): boolean => tab.status === "idle" || tab.status === "exited";

/**
 * The agent threads to list: agent tabs only, idle and ended ones only with `showIdle`, filtered by
 * `query` (every word found in the title, worktree name, branch or profile, any case), newest output
 * first. With `groupByWorktree` the groups keep that order, by their newest thread.
 */
export function activityThreads(
  tabs: readonly ThreadSource[],
  names: Readonly<Record<string, WorktreeName>>,
  query: string,
  options: ActivityOptions,
): ThreadGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const threads: Thread[] = [];
  for (const { tab, lastOutput } of tabs) {
    if (!tab.agent || (resting(tab) && !options.showIdle)) continue;
    const named = names[tab.worktree];
    const thread: Thread = { tab, worktree: tab.worktree, worktreeName: named?.name ?? tab.worktree, branch: named?.branch ?? null, lastOutput };
    const hay = [tab.title ?? "", thread.worktreeName, thread.branch ?? "", tab.profileId].join("\n").toLowerCase();
    if (words.every((w) => hay.includes(w))) threads.push(thread);
  }
  // Array.sort is stable, so equal times keep the order the tabs came in.
  threads.sort((a, b) => (b.lastOutput ?? 0) - (a.lastOutput ?? 0));
  if (threads.length === 0) return [];
  if (!options.groupByWorktree) return [{ worktree: null, name: null, threads }];
  const groups = new Map<string, ThreadGroup>();
  for (const thread of threads) {
    let group = groups.get(thread.worktree);
    if (!group) groups.set(thread.worktree, (group = { worktree: thread.worktree, name: thread.worktreeName, threads: [] }));
    group.threads.push(thread);
  }
  return [...groups.values()];
}
