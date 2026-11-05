import { toApiError, type Api, type FsChanged, type FsEvent } from "@/api";
import type { FileIo } from "@/files/fileIO";
import { reconcile, resetWatchState } from "@/files/fileWatch";

/** `live` while events flow; `limit` when the system ran out of watches; `off` when watching stopped. */
export type WatchHealth = "live" | "limit" | "off";

export interface WatchOptions {
  api: Api;
  worktree: string;
  /** Read on each batch: the translator changes with the language, the subscription does not. */
  io: () => FileIo;
  /** Each batch, after the open files have seen it; for the file tree. */
  onBatch: (events: FsEvent[]) => void;
  onHealth: (health: WatchHealth) => void;
}

let counter = 0;

/**
 * One subscription to the disk events of a worktree. Each batch goes to the open buffers
 * (`reconcile`) and then to `onBatch`. A watch that cannot start leaves the app as it was: the tree
 * still refreshes on its own triggers.
 */
export class WorktreeWatch {
  private readonly id = `watch-${++counter}`;
  private live = true;
  private started: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: WatchOptions) {}

  start(): void {
    const { api, worktree, onHealth } = this.o;
    this.started = api
      .filesWatch(worktree, this.id, (batch) => this.receive(batch))
      .then(
        () => this.live && onHealth("live"),
        (e) => this.live && onHealth(toApiError(e).code === "watch_limit" ? "limit" : "off"),
      );
  }

  private receive(batch: FsChanged): void {
    const { worktree, io, onBatch, onHealth } = this.o;
    if (!this.live || batch.worktree !== worktree) return;
    reconcile(io(), worktree, batch.events);
    onBatch(batch.events);
    if (batch.failure) onHealth(batch.failure === "watchLimit" ? "limit" : "off");
  }

  stop(): void {
    const { api, worktree } = this.o;
    this.live = false;
    resetWatchState(worktree);
    // After the start settles, so an unwatch never overtakes its own watch.
    void this.started.then(() => api.filesUnwatch(this.id)).catch(() => undefined);
  }
}
