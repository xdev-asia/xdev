const REVEAL_KEY = "xdev.tree.revealActive";

/** The folders above `rel`, outermost first: `a/b/c.ts` gives `a`, `a/b`. */
export function ancestorsOf(rel: string): string[] {
  const out: string[] = [];
  for (let i = rel.indexOf("/"); i >= 0; i = rel.indexOf("/", i + 1)) out.push(rel.slice(0, i));
  return out;
}

/** `open` with every folder above `rel` added; the same array when nothing was missing. */
export function revealOpen(open: string[], rel: string): string[] {
  const missing = ancestorsOf(rel).filter((d) => !open.includes(d));
  return missing.length === 0 ? open : [...open, ...missing];
}

/** Whether the tree follows the active file; on when nothing is saved or storage cannot be read. */
export function loadReveal(): boolean {
  try {
    return localStorage.getItem(REVEAL_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveReveal(on: boolean): void {
  try {
    if (on) localStorage.removeItem(REVEAL_KEY);
    else localStorage.setItem(REVEAL_KEY, "0");
  } catch {
    // The choice only fails to survive a restart.
  }
}

const IGNORED_KEY = "xdev.tree.showIgnored";

/** Whether the tree shows what git ignores (dimmed); on when nothing is saved or storage cannot be read. */
export function loadShowIgnored(): boolean {
  try {
    return localStorage.getItem(IGNORED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveShowIgnored(on: boolean): void {
  try {
    if (on) localStorage.removeItem(IGNORED_KEY);
    else localStorage.setItem(IGNORED_KEY, "0");
  } catch {
    // The choice only fails to survive a restart.
  }
}

/** A manual "Reveal in file tree": which file of which worktree. */
export interface TreeRevealRequest {
  worktree: string;
  rel: string;
}

const revealListeners = new Set<(req: TreeRevealRequest) => void>();

/** Asks the file tree of `worktree` to open the folders above `rel`, scroll to it and flash its row. */
export function requestTreeReveal(worktree: string, rel: string): void {
  for (const fn of [...revealListeners]) fn({ worktree, rel });
}

/** Calls `fn` for every request; returns the way to stop. */
export function onTreeReveal(fn: (req: TreeRevealRequest) => void): () => void {
  revealListeners.add(fn);
  return () => void revealListeners.delete(fn);
}
