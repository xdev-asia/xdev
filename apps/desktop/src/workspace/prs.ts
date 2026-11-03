import { toApiError, type Api, type ApiError, type Check, type PrView } from "../api";

type Entry = { pr: PrView | null; checks: Check[] | null; error?: ApiError };

/**
 * The pull request and checks of each worktree, read through the api. One read per path runs at a
 * time; whoever asks while it runs gets the same promise. The version counter feeds
 * `useSyncExternalStore`.
 */
export class PrStore {
  private entries = new Map<string, Entry>();
  private running = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly api: Api) {}

  get(path: string): Entry | undefined {
    return this.entries.get(path);
  }

  load(path: string, opts: { checks?: boolean } = {}): Promise<void> {
    const again = this.running.get(path);
    if (again) return again;
    const run = this.read(path, opts.checks === true).finally(() => this.running.delete(path));
    this.running.set(path, run);
    return run;
  }

  set(path: string, pr: PrView | null): void {
    this.entries.set(path, { pr, checks: null });
    this.bump();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot = (): number => this.version;

  private async read(path: string, withChecks: boolean): Promise<void> {
    const before = this.entries.get(path);
    try {
      const pr = await this.api.worktreePr(path);
      const checks = withChecks && pr ? await this.api.worktreePrChecks(path, pr.number) : pr ? (before?.checks ?? null) : null;
      this.entries.set(path, { pr, checks });
    } catch (e) {
      this.entries.set(path, { pr: before?.pr ?? null, checks: before?.checks ?? null, error: toApiError(e) });
    }
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }
}
