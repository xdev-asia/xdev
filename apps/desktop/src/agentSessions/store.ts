import { toApiError, type Api, type ApiError, type SessionQuery, type SessionRow } from "@/api";
import type { Sessions } from "@/workspace/sessions";

/** A visible panel re-reads the logs this often. */
export const REFRESH_MS = 60_000;
export const PAGE = 100;

export interface AgentSessionsState {
  query: SessionQuery;
  rows: SessionRow[];
  /** A read is in flight. */
  loading: boolean;
  /** The last read failed; the rows are from before. */
  error: ApiError | null;
}

export const DEFAULT_QUERY: SessionQuery = { text: null, scope: { kind: "all" }, agent: null, homeId: null, sort: "lastDesc", limit: PAGE };

/**
 * The agent session list the panel and the palette share: the last query and its rows. `refresh` has
 * Rust read new log bytes; `setQuery` only filters what the index holds.
 */
export class AgentSessionsStore {
  private current: AgentSessionsState = { query: DEFAULT_QUERY, rows: [], loading: false, error: null };
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unlisten: Promise<() => void> | null;
  private disposed = false;

  constructor(
    private readonly api: Pick<Api, "agentSessions" | "onPtyExit">,
    sessions: Pick<Sessions, "tab"> | null,
  ) {
    // An agent that ended has just written its log: one refresh shows it.
    this.unlisten = sessions
      ? api.onPtyExit((e) => {
          if (sessions.tab(e.id)?.agent) void this.refresh();
        })
      : null;
  }

  get state(): AgentSessionsState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes the query and reads the index again, without touching the logs. */
  setQuery(patch: Partial<SessionQuery>): Promise<void> {
    this.set({ query: { ...this.current.query, ...patch } });
    return this.read(false);
  }

  /** Reads the logs for new sessions, then the list. */
  refresh(): Promise<void> {
    return this.read(true);
  }

  /** For a panel that is on screen: refreshes now and every minute; the returned function stops it. */
  watch(): () => void {
    this.watchers++;
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--this.watchers === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
    void this.unlisten?.then((stop) => stop()).catch(() => {});
  }

  private async read(refresh: boolean): Promise<void> {
    const mine = ++this.serial;
    this.set({ loading: true });
    try {
      const rows = await this.api.agentSessions(this.current.query, refresh);
      // A newer read owns the state.
      if (mine === this.serial) this.set({ rows, loading: false, error: null });
    } catch (e) {
      if (mine === this.serial) this.set({ loading: false, error: toApiError(e) });
    }
  }

  private set(patch: Partial<AgentSessionsState>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
