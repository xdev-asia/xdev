// The files opened last, per worktree.

import { QUICK_OPEN_RECENT_MAX } from "./quickOpen";

export const RECENT_FILES_KEY = "xdev.quickOpen.recent.v1";

/** Per worktree, newest first, at most `QUICK_OPEN_RECENT_MAX`, kept in localStorage. */
export class RecentFiles {
  private readonly lists = new Map<string, string[]>();

  constructor(private readonly storage: Storage | null = defaultStorage()) {
    try {
      const raw = storage?.getItem(RECENT_FILES_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        for (const [wt, list] of Object.entries(saved)) {
          if (Array.isArray(list)) this.lists.set(wt, list.filter((x): x is string => typeof x === "string").slice(0, QUICK_OPEN_RECENT_MAX));
        }
      }
    } catch {
      // Recency is a convenience; a bad store starts empty.
    }
  }

  list(worktree: string): string[] {
    return this.lists.get(worktree) ?? [];
  }

  touch(worktree: string, rel: string): void {
    const next = [rel, ...this.list(worktree).filter((r) => r !== rel)].slice(0, QUICK_OPEN_RECENT_MAX);
    this.lists.set(worktree, next);
    try {
      this.storage?.setItem(RECENT_FILES_KEY, JSON.stringify(Object.fromEntries(this.lists)));
    } catch {
      // Ignored: see the constructor.
    }
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The one list the app uses. */
export const recentFiles = new RecentFiles();
