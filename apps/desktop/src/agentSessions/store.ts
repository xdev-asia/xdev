import { toApiError, type Api, type ApiError, type SessionQuery, type SessionRow } from "@/api";
import type { Sessions } from "@/workspace/sessions";

/** A visible panel re-reads the logs this often. */
export const REFRESH_MS = 60_000;
export const PAGE = 100;
/** The search box waits this long after the last key. */
export const SEARCH_MS = 150;
const LIMIT_MAX = 500;

export interface AgentSessionsState {
  query: SessionQuery;
  rows: SessionRow[];
  /** A read is in flight. */
  loading: boolean;
  /** The last read failed; the rows are from before. */
  error: ApiError | null;
  /** Every home a read has shown, sorted; the home filter lists these. */
  homes: string[];
  /** The list is as long as the limit, so there may be more rows. */
  more: boolean;
  /** The person let the app index conversation text, so a search also looks inside it. */
  contentSearch: boolean;
}

export const DEFAULT_QUERY: SessionQuery = { text: null, scope: { kind: "all" }, agent: null, homeId: null, sort: "lastDesc", limit: PAGE };

/**
 * The agent session list the panel and the palette share: the last query and its rows. `refresh` has
 * Rust read new log bytes; `setQuery` only filters what the index holds.
 */
export class AgentSessionsStore {
  private current: AgentSessionsState = { query: DEFAULT_QUERY, rows: [], loading: false, error: null, homes: [], more: false, contentSearch: false };
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unlisten: Promise<() => void> | null;
  private disposed = false;
  private typing: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: Pick<Api, "agentSessions" | "agentsSettings" | "onPtyExit">,
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

  /** The search text, applied `SEARCH_MS` after the last call. Blank means no text. */
  search(text: string): void {
    if (this.typing) clearTimeout(this.typing);
    this.typing = setTimeout(() => {
      this.typing = null;
      void this.setQuery({ text: text.trim() === "" ? null : text.trim() });
    }, SEARCH_MS);
  }

  /** Shows one more page of rows. */
  loadMore(): Promise<void> {
    const limit = Math.min(LIMIT_MAX, this.current.query.limit + PAGE);
    return limit === this.current.query.limit ? Promise.resolve() : this.setQuery({ limit });
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
    if (this.typing) clearTimeout(this.typing);
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
      const contentSearch = await this.api.agentsSettings().then((s) => s.sessionSearch, () => false);
      // A newer read owns the state.
      if (mine !== this.serial) return;
      const homes = [...new Set([...this.current.homes, ...rows.map((r) => r.session.homeId)])].sort();
      this.set({ rows, loading: false, error: null, homes, contentSearch, more: rows.length >= this.current.query.limit });
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
