// The changes panel and the review tab show the same worktree through different reads.
// Whichever one changes the index or the disk says so here, and the other reads again.
const listeners = new Map<string, Set<() => void>>();

/** Calls `fn` whenever `touchChanges(worktree)` runs; returns the way to stop. */
export function onChangesTouched(worktree: string, fn: () => void): () => void {
  let set = listeners.get(worktree);
  if (!set) listeners.set(worktree, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0 && listeners.get(worktree) === set) listeners.delete(worktree);
  };
}

/** Says that the stage state or the files of `worktree` changed; `from` is the caller's own listener, which reads on its own. */
export function touchChanges(worktree: string, from?: () => void): void {
  for (const fn of [...(listeners.get(worktree) ?? [])]) if (fn !== from) fn();
}
