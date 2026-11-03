export const RECENT_KEY = "xdev.palette.recent.v1";
const CAP = 100;
const PERSISTED = "wt:";

/**
 * When each palette entry was last used. Worktree entries survive a restart through
 * localStorage; tab entries stay in memory, since tabs do not survive one.
 */
export class RecentStore {
  private readonly times = new Map<string, number>();

  constructor(
    private readonly storage: Storage | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
  ) {
    try {
      const raw = storage?.getItem(RECENT_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        for (const [id, at] of Object.entries(saved)) {
          if (id.startsWith(PERSISTED) && typeof at === "number") this.times.set(id, at);
        }
      }
    } catch {
      // Recency is a convenience; a bad store starts empty.
    }
  }

  /** Marks `id` as used now. Times only move forward. */
  touch(id: string): void {
    const at = this.now();
    const prev = this.times.get(id);
    if (prev !== undefined && prev >= at) return;
    this.times.set(id, at);
    if (id.startsWith(PERSISTED)) this.save();
  }

  at(id: string): number | null {
    return this.times.get(id) ?? null;
  }

  private save(): void {
    const kept = [...this.times]
      .filter(([id]) => id.startsWith(PERSISTED))
      .sort((a, b) => b[1] - a[1])
      .slice(0, CAP);
    for (const [id] of [...this.times]) {
      if (id.startsWith(PERSISTED) && !kept.some(([k]) => k === id)) this.times.delete(id);
    }
    try {
      this.storage?.setItem(RECENT_KEY, JSON.stringify(Object.fromEntries(kept)));
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
