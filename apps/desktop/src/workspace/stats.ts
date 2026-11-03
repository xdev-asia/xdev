import type { Api, WorktreeStat } from "@/api";
import type { Sessions } from "./sessions";
import type { TabStatus } from "./status";

/** The window events the store listens to; `window` fits, a test passes its own. */
export interface FocusTarget {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
}

/** A focus this soon after the last focus read redraws only: each read runs git per worktree. */
export const FOCUS_GAP_MS = 30_000;

/** A worktree that reaches one of these has stopped working, so its files likely changed. */
const SETTLED: TabStatus[] = ["idle", "done", "exited", "failed"];

/**
 * The line counts of every listed worktree. A count is read when the worktree is first listed,
 * when its status settles (idle, done, exited, failed) and when the window gains focus at least
 * 30 s after the last focus read; never on a timer. Views read it through `subscribe` + `snapshot`.
 */
export class WorktreeStats {
  private data: Record<string, WorktreeStat | undefined> = {};
  private paths: string[] = [];
  // The status each path had at the last look, to see it change.
  private dots = new Map<string, TabStatus | null>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private api: Api | null = null;
  private sessions: Sessions | null = null;
  private off: (() => void) | null = null;
  private sweeping = false;
  // When the last focus read ended; -Infinity before the first.
  private swept = -Infinity;

  /** Changes whenever the counts do, or the window regains focus so relative times redraw. */
  snapshot = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** The counts read so far, by worktree path. The same object until something changes. */
  all(): Record<string, WorktreeStat | undefined> {
    return this.data;
  }

  /** Starts watching: status changes of `sessions` and focus of `target`. Reads what is listed. */
  attach(api: Api, sessions: Sessions, target?: FocusTarget): void {
    this.detach();
    this.api = api;
    this.sessions = sessions;
    const stop = sessions.subscribe(() => this.settled());
    const onFocus = () => void this.focused();
    target?.addEventListener("focus", onFocus);
    this.off = () => {
      stop();
      target?.removeEventListener("focus", onFocus);
    };
    for (const path of this.paths) this.dots.set(path, sessions.dot(path));
    void this.sweep(this.paths);
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this.api = null;
    this.sessions = null;
  }

  /** Sets the listed worktrees: reads the new ones, forgets the gone ones. */
  track(paths: string[]): void {
    const fresh = paths.filter((p) => !this.paths.includes(p));
    this.paths = paths;
    const gone = Object.keys(this.data).filter((p) => !paths.includes(p));
    if (gone.length > 0) {
      this.data = Object.fromEntries(Object.entries(this.data).filter(([p]) => paths.includes(p)));
      this.bump();
    }
    for (const path of [...this.dots.keys()]) if (!paths.includes(path)) this.dots.delete(path);
    if (!this.api) return;
    for (const path of fresh) this.dots.set(path, this.sessions?.dot(path) ?? null);
    void this.sweep(fresh);
  }

  private settled(): void {
    const sessions = this.sessions;
    if (!sessions) return;
    const changed: string[] = [];
    for (const path of this.paths) {
      const dot = sessions.dot(path);
      if (dot !== (this.dots.get(path) ?? null) && dot && SETTLED.includes(dot)) changed.push(path);
      this.dots.set(path, dot);
    }
    void this.sweep(changed);
  }

  private async focused(): Promise<void> {
    // Redraw first, so the times move even when no count does.
    this.bump();
    if (this.sweeping || Date.now() - this.swept < FOCUS_GAP_MS) return;
    this.sweeping = true;
    try {
      await this.sweep(this.paths);
    } finally {
      this.sweeping = false;
      this.swept = Date.now();
    }
  }

  // One at a time: each count runs git in that worktree.
  private async sweep(paths: string[]): Promise<void> {
    for (const path of paths) await this.read(path);
  }

  private async read(path: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    let stat: WorktreeStat;
    try {
      stat = await api.worktreeStat(path);
    } catch {
      // The count stays as it was; the row simply shows the last one.
      return;
    }
    // Detached, or no longer listed, while the read ran.
    if (this.api !== api || !this.paths.includes(path)) return;
    const old = this.data[path];
    if (old && old.files === stat.files && old.added === stat.added && old.removed === stat.removed) return;
    this.data = { ...this.data, [path]: stat };
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }
}
