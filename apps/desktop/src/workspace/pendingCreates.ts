import { toApiError, type ApiError, type WorktreeView } from "@/api";

/** What a create was asked with; Retry asks again with the same. */
export type CreateArgs = { repoId: string; name: string; from: string | null };

/** A create still running, or one that failed and waits for Retry or Dismiss. */
export type PendingCreate = {
  id: string;
  repoId: string;
  name: string;
  from: string | null;
  state: "running" | "failed";
  error?: ApiError;
};

export interface PendingCreatesDeps {
  create(repoId: string, name: string, from: string | null): Promise<WorktreeView>;
  /** Takes back a worktree whose create was cancelled; a fresh one is clean, so no force. */
  remove(path: string, force: boolean): Promise<unknown>;
  /** A create that was not cancelled finished. */
  onCreated(view: WorktreeView, args: CreateArgs): void;
}

type Job = { id: string; args: CreateArgs; state: PendingCreate["state"]; error?: ApiError; cancelled: boolean; attempt: number };

/**
 * Worktree creates that run after the dialog has closed. Each job keeps its own row: Cancel hides
 * it at once and removes the worktree if the call still succeeds; a failure stays listed with
 * Retry and Dismiss. Several may run at once; the backend's workspace lock runs them in turn.
 */
export class PendingCreates {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private changes = 0;

  constructor(private readonly deps: PendingCreatesDeps) {}

  start(args: CreateArgs): string {
    const id = `create-${++this.seq}`;
    const job: Job = { id, args: { ...args }, state: "running", cancelled: false, attempt: 0 };
    this.jobs.set(id, job);
    this.run(job);
    return id;
  }

  /** A running job: hidden now, and the worktree removed if it still gets made. A failed one goes. */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    this.jobs.delete(id);
    this.emit();
  }

  /** Runs a failed job again with the same arguments. */
  retry(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.state !== "failed") return;
    this.run(job);
  }

  dismiss(id: string): void {
    if (this.jobs.get(id)?.state === "failed") this.cancel(id);
  }

  /** The jobs of one repo, or all, in the order they were started. */
  list(repoId?: string): PendingCreate[] {
    return [...this.jobs.values()]
      .filter((j) => repoId === undefined || j.args.repoId === repoId)
      .map((j) => ({ id: j.id, ...j.args, state: j.state, ...(j.error ? { error: j.error } : {}) }));
  }

  /** Goes up on every change; a stable snapshot for `useSyncExternalStore`. */
  get version(): number {
    return this.changes;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private run(job: Job): void {
    const attempt = ++job.attempt;
    job.state = "running";
    job.error = undefined;
    this.emit();
    const { repoId, name, from } = job.args;
    this.deps.create(repoId, name, from).then(
      (view) => {
        if (job.cancelled) {
          // Made after all: take it back. A remove that fails leaves an ordinary worktree.
          this.deps.remove(view.path, false).catch(() => undefined);
          return;
        }
        if (job.attempt !== attempt) return;
        this.jobs.delete(job.id);
        this.emit();
        this.deps.onCreated(view, { ...job.args });
      },
      (e: unknown) => {
        if (job.cancelled || job.attempt !== attempt) return;
        job.state = "failed";
        job.error = toApiError(e);
        this.emit();
      },
    );
  }

  private emit(): void {
    this.changes++;
    for (const fn of this.listeners) fn();
  }
}
