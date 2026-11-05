import { toApiError, type Api, type ApiError, type PortScan } from "@/api";

const POLL_MS = 30_000;
const AFTER_URL_MS = 1_000;
const AFTER_STOP_MS = 500;

export type PortsState = {
  scan: PortScan | null;
  /** Set when the last call itself failed. */
  error: ApiError | null;
  loading: boolean;
};

/**
 * The listening ports, read through the api. Polls every 30 s while the panel is visible; a
 * newly visible panel and a URL a terminal printed force a scan. Scans in flight are shared. The
 * last good list survives one failed call.
 */
export class PortsStore {
  private current: PortsState = { scan: null, error: null, loading: false };
  private worktrees: string[] = [];
  private running: Promise<void> | null = null;
  private visible = false;
  private wanted = new Set<string>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private failures = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly api: Api) {}

  state(): PortsState {
    return this.current;
  }

  snapshot = (): number => this.version;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  setWorktrees(paths: readonly string[]): void {
    if (paths.length === this.worktrees.length && paths.every((p, i) => p === this.worktrees[i])) return;
    this.worktrees = [...paths];
    if (this.visible) void this.refresh();
  }

  /** The Ports panel is in front. */
  setVisible(visible: boolean): void {
    this.want("panel", visible);
  }

  /** Something on screen reads the list: the panel, or the Ports part of the cards. Polling runs while any does. */
  want(who: string, on: boolean): void {
    if (on) this.wanted.add(who);
    else this.wanted.delete(who);
    this.apply(this.wanted.size > 0);
  }

  /** Polling runs only while wanted; becoming wanted scans at once. */
  private apply(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (!visible) return;
    this.poll = setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
  }

  /** Listens for printed URLs: one scan now and one a second later. */
  watch(): Promise<() => void> {
    return this.api.onPortsAdvertised(() => {
      void this.refresh();
      this.later(AFTER_URL_MS, () => this.refresh());
    });
  }

  /** One scan; whoever asks while one runs gets the same promise. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.current = { ...this.current, loading: true };
    this.bump();
    const run = this.api.portsScan(this.worktrees, true).then(
      (scan) => {
        this.failures = 0;
        this.current = { scan, error: null, loading: false };
      },
      (e: unknown) => {
        this.failures += 1;
        const keep = this.failures <= 1 ? this.current.scan : null;
        this.current = { scan: keep, error: toApiError(e), loading: false };
      },
    );
    this.running = run.finally(() => {
      this.running = null;
      this.bump();
    });
    return this.running;
  }

  /** Stops the process behind port `id`, then scans again half a second later. */
  async stop(id: string): Promise<void> {
    const scan = await this.api.portsStop(this.worktrees, id);
    this.failures = 0;
    this.current = { scan, error: null, loading: false };
    this.bump();
    this.later(AFTER_STOP_MS, () => this.refresh());
  }

  dispose(): void {
    this.wanted.clear();
    this.apply(false);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void fn();
    }, ms);
    this.timers.add(t);
  }

  private bump(): void {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }
}
