import type { WorktreeView } from "@/api";

/** The worktrees that name `wt` as their parent. `all` is the worktrees of one repo. */
export function childrenOf(wt: WorktreeView, all: WorktreeView[]): WorktreeView[] {
  return all.filter((w) => w.parent === wt.path);
}

/** The listed worktree `wt` hangs under, or null. */
export function parentOf(wt: WorktreeView, all: WorktreeView[]): WorktreeView | null {
  return wt.parent === null ? null : (all.find((w) => w.path === wt.parent) ?? null);
}

/**
 * The worktrees `wt` may be put under: one level only, so a linked worktree that has no parent of its own,
 * and only while `wt` has no children. `all` is the worktrees of one repo. The current parent is not offered.
 */
export function parentCandidates(wt: WorktreeView, all: WorktreeView[]): WorktreeView[] {
  if (wt.primary || childrenOf(wt, all).length > 0) return [];
  return all.filter((w) => w.path !== wt.path && !w.primary && w.parent === null && w.path !== wt.parent);
}
