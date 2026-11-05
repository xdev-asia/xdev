import type { KeptBranch } from "@/api";

export type DeleteSwitches = { alwaysForce: boolean; alwaysDeleteKept: boolean };

/** What `worktreeRemove` gets: a dirty row or Always force deletes with force; the branch follows its own switch. */
export function removeArgs(dirty: boolean, sw: DeleteSwitches): { force: boolean; deleteUnmerged: boolean } {
  return { force: dirty || sw.alwaysForce, deleteUnmerged: sw.alwaysDeleteKept };
}

/** The "Don't ask again" tick: one clean worktree with no children. */
export function showsDontAsk(s: { dirty: boolean; children: number; count: number }): boolean {
  return s.count === 1 && s.children === 0 && !s.dirty;
}

export type KeptOutcome = { kind: "one"; kept: KeptBranch } | { kind: "many"; count: number };

/** The toast after a delete that left branches behind. */
export function keptOutcome(kept: KeptBranch[]): KeptOutcome | null {
  if (kept.length === 0) return null;
  return kept.length === 1 ? { kind: "one", kept: kept[0] } : { kind: "many", count: kept.length };
}
