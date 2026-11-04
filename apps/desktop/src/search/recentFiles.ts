// The files opened last, per worktree. Contract stub: Lane U (U1) fills it in.

import { QUICK_OPEN_RECENT_MAX } from "./quickOpen";

export const RECENT_FILES_KEY = "xdev.quickOpen.recent.v1";

/** Per worktree, newest first, at most `QUICK_OPEN_RECENT_MAX`, kept in localStorage. */
export class RecentFiles {
  list(worktree: string): string[] {
    void worktree;
    return [];
  }

  touch(worktree: string, rel: string): void {
    void worktree;
    void rel;
    void QUICK_OPEN_RECENT_MAX;
  }
}
