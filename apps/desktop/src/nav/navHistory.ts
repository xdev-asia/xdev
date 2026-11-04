// Worktree navigation history, in memory only (plan R1).

export interface NavEntry {
  worktree: string;
  tab: string | null;
}

/** Entries kept; the oldest go first. */
export const NAV_CAP = 50;
