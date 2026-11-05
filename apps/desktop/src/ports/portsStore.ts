import { toApiError, type Api, type ApiError, type PortScan, type PortStopConsent } from "@/api";

/** While a ports surface is on screen. */
export const POLL_MS = 5_000;
/** While a ports surface is open but the window is hidden or minimised. */
export const HIDDEN_POLL_MS = 30_000;
const AFTER_URL_MS = 1_000;
const AFTER_STOP_MS = 500;

export type PortsState = {
  scan: PortScan | null;
  /** Set when the last call itself failed. */
  error: ApiError | null;
  loading: boolean;
};

/**
 * The listening ports, read through the api. Polls every 5 s while a ports surface is on screen
 * and every 30 s while the window is hidden; nothing polls while no surface reads the list. A
 * newly visible surface and a URL a terminal printed force a scan. Scans in flight are shared. The
 * last good list survives one failed call.
 */
export class PortsStore {
  private current: PortsState = { scan: null, error: null, loading: false };
  private worktrees: string[] = [];
  private running: Promise<void> | null = null;
  private visible = false;
  private hidden = false;
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

  /** The window is hidden or minimised: polling slows down, and a window shown again scans at once. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (!this.visible) return;
    this.restart();
    if (!hidden) void this.refresh();
  }

  /** Polling runs only while wanted; becoming wanted scans at once. */
  private apply(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.restart();
    if (visible) void this.refresh();
  }

  private restart(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.visible) this.poll = setInterval(() => void this.refresh(), this.hidden ? HIDDEN_POLL_MS : POLL_MS);
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
  async stop(id: string, consent: PortStopConsent): Promise<void> {
    const scan = await this.api.portsStop(this.worktrees, id, consent);
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
