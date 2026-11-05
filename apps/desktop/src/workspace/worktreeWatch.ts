import { toApiError, type Api, type FsChanged, type FsEvent } from "@/api";
import type { FileIo } from "@/files/fileIO";
import { realTimers, reconcile, resetWatchState, type Timers } from "@/files/fileWatch";

/** `live` while events flow; `limit` when the system ran out of watches; `off` when watching stopped. */
export type WatchHealth = "live" | "limit" | "off";

/** The first restart comes this long after a failure; each next one waits twice as long, up to the max. */
export const RETRY_FIRST_MS = 1000;
export const RETRY_MAX_MS = 60_000;

/** Start errors worth trying again: the limit may be raised, a backend error may pass. */
const RETRIED = new Set(["watch_limit", "io"]);

const OVERFLOW: FsEvent = { kind: "overflow", rel: "", dir: null };

export interface WatchOptions {
  api: Api;
  worktree: string;
  /** Read on each batch: the translator changes with the language, the subscription does not. */
  io: () => FileIo;
  /** Each batch, after the open files have seen it; for the file tree. */
  onBatch: (events: FsEvent[]) => void;
  onHealth: (health: WatchHealth) => void;
  timers?: Timers;
}

let counter = 0;

/**
 * One subscription to the disk events of a worktree. Each batch goes to the open buffers
 * (`reconcile`) and then to `onBatch`. A watcher that fails, or cannot start for a reason that may
 * pass, is started again with a backoff. Each time a subscription starts, the open files are read
 * again, since events were missed meanwhile; after a restart the tree is too.
 */
export class WorktreeWatch {
  private readonly id = `watch-${++counter}`;
  private readonly timers: Timers;
  private live = true;
  private started: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private retry: unknown = null;

  constructor(private readonly o: WatchOptions) {
    this.timers = o.timers ?? realTimers;
  }

  start(): void {
    this.subscribe(false);
  }

  private subscribe(again: boolean): void {
    const { api, worktree, onHealth } = this.o;
    this.started = api
      .filesWatch(worktree, this.id, (batch) => this.receive(batch))
      .then(
        () => {
          if (!this.live) return;
          onHealth("live");
          // Nothing watched before this: the open files may have changed (another worktree was
          // shown, or the watcher was down). The tree lists afresh on its own when it first shows.
          reconcile(this.o.io(), worktree, [OVERFLOW], this.timers);
          if (again) this.o.onBatch([OVERFLOW]);
        },
        (e) => {
          if (!this.live) return;
          const code = toApiError(e).code;
          onHealth(code === "watch_limit" ? "limit" : "off");
          if (RETRIED.has(code)) this.later();
        },
      );
  }

  /** Starts the watch again after the next backoff step. */
  private later(): void {
    if (this.retry !== null) return;
    const ms = Math.min(RETRY_FIRST_MS * 2 ** this.attempt, RETRY_MAX_MS);
    this.attempt++;
    this.retry = this.timers.set(() => {
      this.retry = null;
      if (this.live) this.subscribe(true);
    }, ms);
  }

  private receive(batch: FsChanged): void {
    const { worktree, io, onBatch, onHealth } = this.o;
    if (!this.live || batch.worktree !== worktree) return;
    reconcile(io(), worktree, batch.events, this.timers);
    onBatch(batch.events);
    if (batch.failure) {
      onHealth(batch.failure === "watchLimit" ? "limit" : "off");
      this.later();
    } else {
      // Events flow: the next failure starts the backoff over.
      this.attempt = 0;
    }
  }

  /** Reads the open files and the tree again, as after lost events (the window got focus back). */
  recheck(): void {
    const { worktree, io, onBatch } = this.o;
    if (!this.live) return;
    reconcile(io(), worktree, [OVERFLOW], this.timers);
    onBatch([OVERFLOW]);
  }

  stop(): void {
    const { api, worktree } = this.o;
    this.live = false;
    if (this.retry !== null) this.timers.clear(this.retry);
    this.retry = null;
    resetWatchState(worktree);
    // After the start settles, so an unwatch never overtakes its own watch.
    void this.started.then(() => api.filesUnwatch(this.id)).catch(() => undefined);
  }
}
