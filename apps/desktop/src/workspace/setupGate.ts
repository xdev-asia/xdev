import type { Sessions } from "./sessions";

/** What a worktree's waiting agents see: setup still runs, or it failed and the person must choose. */
export type GateState = { phase: "running" } | { phase: "failed"; code: number | null };

interface Watch {
  tabId: string;
  wait: boolean;
  /** Agent launches held back until the setup tab ends. */
  pending: (() => void)[];
  failed: { code: number | null } | null;
}

/**
 * Holds agent launches of a worktree while its setup tab runs, when the repo says agents wait for
 * setup. It reads the tab's stored exit, so an exit that came before `track` is not missed.
 */
export class SetupGate {
  private sessions: Sessions | null = null;
  private readonly watches = new Map<string, Watch>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Follows `sessions`; returns the stop function. */
  attach(sessions: Sessions): () => void {
    this.sessions = sessions;
    const off = sessions.subscribe(() => this.sync());
    return () => {
      off();
      if (this.sessions === sessions) this.sessions = null;
    };
  }

  /** The setup tab `tabId` of `worktree` was opened; `wait` is the repo's wait-for-setup setting. */
  track(worktree: string, tabId: string, wait: boolean): void {
    this.watches.set(worktree, { tabId, wait, pending: [], failed: null });
    this.sync();
  }

  /** The id of the setup tab being tracked, if any; the shell fronts it for "Open setup tab". */
  setupTab(worktree: string): string | null {
    return this.watches.get(worktree)?.tabId ?? null;
  }

  /** True when `launch` was held back; it runs once setup ends or `startNow` is called. */
  defer(worktree: string, launch: () => void): boolean {
    const watch = this.watches.get(worktree);
    if (!watch || !watch.wait || !this.running(worktree, watch)) return false;
    watch.pending.push(launch);
    this.bump();
    return true;
  }

  /** Runs what waits and stops waiting for this worktree. */
  startNow(worktree: string): void {
    this.release(worktree);
  }

  /** Null when nothing waits on setup in this worktree. */
  state(worktree: string): GateState | null {
    const watch = this.watches.get(worktree);
    if (!watch || watch.pending.length === 0) return null;
    return watch.failed ? { phase: "failed", code: watch.failed.code } : { phase: "running" };
  }

  /** A number that changes with every state change, for `useSyncExternalStore`. */
  snapshot(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private running(worktree: string, watch: Watch): boolean {
    const tab = this.sessions?.tabs(worktree).find((t) => t.id === watch.tabId);
    return tab !== undefined && tab.exitCode === undefined;
  }

  private sync(): void {
    if (!this.sessions) return;
    for (const [worktree, watch] of [...this.watches]) {
      const tab = this.sessions.tabs(worktree).find((t) => t.id === watch.tabId);
      // A closed setup tab has nothing more to wait for.
      if (!tab || tab.exitCode === 0) this.release(worktree);
      else if (tab.exitCode !== undefined && !watch.failed) {
        if (watch.pending.length === 0) this.watches.delete(worktree);
        else watch.failed = { code: tab.exitCode };
        this.bump();
      }
    }
  }

  private release(worktree: string): void {
    const watch = this.watches.get(worktree);
    if (!watch) return;
    this.watches.delete(worktree);
    this.bump();
    for (const launch of watch.pending) launch();
  }

  private bump(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}
