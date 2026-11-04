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

  /** Bound, so it can be handed to useSyncExternalStore as is. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Bumps on every change, for useSyncExternalStore. */
  readonly version = (): number => this.ver;

  /** The next entry that way whose worktree is alive and is not the current one. */
  private find(dir: 1 | -1, alive: (worktree: string) => boolean): number {
    const here = this.entries[this.index]?.worktree;
    for (let i = this.index + dir; i >= 0 && i < this.entries.length; i += dir) {
      const wt = this.entries[i].worktree;
      if (wt !== here && alive(wt)) return i;
    }
    return -1;
  }

  /**
   * Drops dead entries and merges the runs of one worktree that the drop leaves side by side
   * (A, dead B, A becomes one A). A run keeps `keep` when it holds it, else its newest entry.
   */
  private settle(kept: NavEntry[], keep: NavEntry): void {
    const merged: NavEntry[] = [];
    for (const e of kept) {
      const last = merged[merged.length - 1];
      if (last && last.worktree === e.worktree) {
        if (last !== keep) merged[merged.length - 1] = e;
      } else {
        merged.push(e);
      }
    }
    this.entries = merged;
    this.index = merged.indexOf(keep);
    this.bump();
  }

  private step(dir: 1 | -1, alive: (worktree: string) => boolean): NavEntry | null {
    const to = this.find(dir, alive);
    const cur = this.entries[this.index];
    if (to === -1) {
      // Nothing alive that way: the dead entries there go anyway.
      const kept = this.entries.filter((e, i) => (dir === -1 ? i >= this.index : i <= this.index) || alive(e.worktree));
      if (kept.length === this.entries.length) return null;
      this.settle(kept, cur);
      return null;
    }
    // Entries passed on the way are dead (or the current worktree again): drop the dead ones.
    const lo = Math.min(this.index, to);
    const hi = Math.max(this.index, to);
    const target = this.entries[to];
    this.settle(
      this.entries.filter((e, i) => i <= lo || i >= hi || alive(e.worktree)),
      target,
    );
    return target;
  }

  private bump(): void {
    this.ver++;
    for (const l of [...this.listeners]) l();
  }
}
