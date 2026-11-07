import type { AgentProfile, AttentionKind, SessionState } from "@xdev-asia/ui";
import { questionLive, type PendingQuestion } from "@/conversation/questionStore";
import type { Tab } from "./sessions";
import type { TabStatus } from "./status";

/** One agent tab that waits on the person: a question or an approval it asked for, or a run that failed. */
export interface NeedsYouEntry {
  tab: Tab;
  kind: AttentionKind;
  /** When the wait began, epoch ms. */
  since: number;
  /** What the agent asks, when its hook said; null otherwise. */
  ask: string | null;
}

/** Everything that waits on the person, from one pass over the tabs. */
export interface NeedsYou {
  /** Longest wait first. */
  entries: NeedsYouEntry[];
  /** How many tabs wait. */
  count: number;
  /** How many tabs wait, per worktree path; a worktree without one is absent. */
  byWorktree: Record<string, number>;
  /** The worktrees with a tab that waits, in the order of `entries`. */
  worktrees: string[];
}

export const NO_NEEDS: NeedsYou = { entries: [], count: 0, byWorktree: {}, worktrees: [] };

const waits = (status: TabStatus): boolean => status === "needs-you" || status === "failed";

/** The kind and the words of one waiting tab: a hook's question wins, then a tool it wants to run. */
function askOf(tab: Tab, q: PendingQuestion | null): { kind: AttentionKind; ask: string | null } {
  if (tab.status === "failed") return { kind: "failed", ask: null };
  const live = q && questionLive(q, tab.status) ? q : null;
  const question = live?.detail?.question ?? null;
  if (question) return { kind: "question", ask: question.text || null };
  if (live?.text) return { kind: "question", ask: live.text };
  return { kind: "approval", ask: live?.detail?.message ?? null };
}

/**
 * The one "needs you" source: agent tabs that are awake and either need the person or failed. The header
 * inbox, the worktree dots, the footer count and the taskbar badge all read it.
 */
export function selectNeedsYou(tabs: readonly Tab[], question: (id: string) => PendingQuestion | null = () => null): NeedsYou {
  const entries: NeedsYouEntry[] = [];
  for (const tab of tabs) {
    if (!tab.agent || tab.asleep || !waits(tab.status)) continue;
    entries.push({ tab, since: tab.statusAt ?? tab.unreadAt ?? tab.openedAt, ...askOf(tab, question(tab.id)) });
  }
  if (entries.length === 0) return NO_NEEDS;
  entries.sort((a, b) => a.since - b.since);
  const byWorktree: Record<string, number> = {};
  for (const e of entries) byWorktree[e.tab.worktree] = (byWorktree[e.tab.worktree] ?? 0) + 1;
  return { entries, count: entries.length, byWorktree, worktrees: Object.keys(byWorktree) };
}

/** The worktree's dot when something there waits (a question before a failure), else null. */
export function needsDot(needs: NeedsYou, worktree: string): "needs-you" | "failed" | null {
  if (!needs.byWorktree[worktree]) return null;
  return needs.entries.some((e) => e.tab.worktree === worktree && e.kind !== "failed") ? "needs-you" : "failed";
}

/** The worktrees the taskbar badge counts: those with a waiting tab whose kind of news is switched on. */
export function badgeWorktrees(needs: NeedsYou, on: (status: "needs-you" | "failed") => boolean): number {
  return new Set(needs.entries.filter((e) => on(e.kind === "failed" ? "failed" : "needs-you")).map((e) => e.tab.worktree)).size;
}

/** The design system's agent chip for a tab's CLI. */
export function agentOf(tab: Pick<Tab, "cli">): AgentProfile {
  return tab.cli ?? "custom";
}

/** The design system's state for a tab status: the app's `needs-you` is its `waiting`. */
export function sessionState(status: TabStatus): SessionState {
  return status === "needs-you" ? "waiting" : status;
}
