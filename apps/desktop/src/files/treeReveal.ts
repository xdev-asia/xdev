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
