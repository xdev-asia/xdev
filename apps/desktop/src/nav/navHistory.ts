// Worktree navigation history, in memory only (plan R1).

export interface NavEntry {
  worktree: string;
  tab: string | null;
}

/** Entries kept; the oldest go first. */
export const NAV_CAP = 50;

/** A browser-like stack of worktrees, each with the tab that was in front. */
export class NavHistory {
  private entries: NavEntry[] = [];
  private index = -1;
  private ver = 0;
  private readonly listeners = new Set<() => void>();

  /** A new worktree: push it and drop the forward part. The worktree at the index: update its tab only. */
  visit(worktree: string, tab: string | null): void {
    if (!worktree) return;
    const at = this.entries[this.index];
    if (at && at.worktree === worktree) {
      if (at.tab === tab) return;
      this.entries[this.index] = { worktree, tab };
    } else {
      this.entries = [...this.entries.slice(0, this.index + 1), { worktree, tab }];
      if (this.entries.length > NAV_CAP) this.entries = this.entries.slice(this.entries.length - NAV_CAP);
      this.index = this.entries.length - 1;
    }
    this.bump();
  }

  /** Step back, skipping entries whose worktree is gone (and dropping them); null at the start. */
  back(alive: (worktree: string) => boolean): NavEntry | null {
    return this.step(-1, alive);
  }

  forward(alive: (worktree: string) => boolean): NavEntry | null {
    return this.step(1, alive);
  }

  canBack(alive: (worktree: string) => boolean): boolean {
    return this.find(-1, alive) !== -1;
  }

  canForward(alive: (worktree: string) => boolean): boolean {
    return this.find(1, alive) !== -1;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Bumps on every change, for useSyncExternalStore. */
  version(): number {
    return this.ver;
  }

  private find(dir: 1 | -1, alive: (worktree: string) => boolean): number {
    for (let i = this.index + dir; i >= 0 && i < this.entries.length; i += dir) {
      if (alive(this.entries[i].worktree)) return i;
    }
    return -1;
  }

  private step(dir: 1 | -1, alive: (worktree: string) => boolean): NavEntry | null {
    const to = this.find(dir, alive);
    if (to === -1) {
      // Nothing alive that way: the dead entries there go anyway.
      const cur = this.entries[this.index];
      const kept = this.entries.filter((e, i) => (dir === -1 ? i >= this.index : i <= this.index) || alive(e.worktree));
      if (kept.length === this.entries.length) return null;
      this.entries = kept;
      this.index = kept.indexOf(cur);
      this.bump();
      return null;
    }
    // Entries passed on the way are dead: drop them and keep the index on the same entry.
    const lo = Math.min(this.index, to);
    const hi = Math.max(this.index, to);
    const kept = this.entries.filter((e, i) => i <= lo || i >= hi || alive(e.worktree));
    const target = this.entries[to];
    this.entries = kept;
    this.index = kept.indexOf(target);
    this.bump();
    return target;
  }

  private bump(): void {
    this.ver++;
    for (const l of [...this.listeners]) l();
  }
}
