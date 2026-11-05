import { toApiError, type Api, type ApiError, type SessionQuery, type SessionRow } from "@/api";
import type { Sessions } from "@/workspace/sessions";
import { GROUP_BYS, HISTORY_DAYS, type GroupBy, type HistoryDays } from "./sessionsView";

/** A visible panel re-reads the logs this often. */
export const REFRESH_MS = 60_000;
export const PAGE = 100;
/** The search box waits this long after the last key. */
export const SEARCH_MS = 150;
const LIMIT_MAX = 500;
/** A refresh that runs this long says so and shows the rows read so far. */
export const READING_MS = 1_000;
/** While a long refresh runs, the rows it has read so far are fetched this often. */
export const POLL_MS = 2_000;

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
  /** A refresh has run for `READING_MS`: the rows are what it has read so far. */
  reading: boolean;
}

export const DEFAULT_QUERY: SessionQuery = { text: null, scope: { kind: "all" }, agent: null, homeId: null, sort: "lastDesc", limit: PAGE };

/** How the panel lays its rows out; kept on this computer. */
export interface ViewPrefs {
  groupBy: GroupBy;
  /** A group with no row has no header. */
  hideEmpty: boolean;
  /** Rows older than this many days by last activity are left out; null shows them all. */
  history: HistoryDays;
}

export const VIEW_KEY = "xdev.agentSessions.view";
export const DEFAULT_VIEW: ViewPrefs = { groupBy: "day", hideEmpty: true, history: null };

/** The saved view; the defaults when nothing is saved, the text is not JSON, or storage cannot be read. */
export function loadView(): ViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    const o: unknown = raw === null ? null : JSON.parse(raw);
    if (!o || typeof o !== "object") return DEFAULT_VIEW;
    const v = o as Record<string, unknown>;
    return {
      groupBy: GROUP_BYS.find((g) => g === v.groupBy) ?? DEFAULT_VIEW.groupBy,
      hideEmpty: typeof v.hideEmpty === "boolean" ? v.hideEmpty : DEFAULT_VIEW.hideEmpty,
      history: HISTORY_DAYS.find((h) => h === v.history) ?? DEFAULT_VIEW.history,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

function saveView(view: ViewPrefs): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // The choice only fails to survive a restart.
  }
}

/**
 * The agent session list the panel and the palette share: the last query and its rows. `refresh` has
 * Rust read new log bytes; `setQuery` only filters what the index holds.
 */
export class AgentSessionsStore {
  private current: AgentSessionsState = {
    query: DEFAULT_QUERY,
    rows: [],
    loading: false,
    error: null,
    homes: [],
    more: false,
    contentSearch: false,
    reading: false,
  };
  private readonly listeners = new Set<() => void>();
  private prefs = loadView();
  private serial = 0;
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unlisten: Promise<() => void> | null;
  private disposed = false;
  private typing: ReturnType<typeof setTimeout> | null = null;
  /** The refresh in flight; another call shares it. */
  private refreshing: Promise<void> | null = null;
  private slow: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

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

  /** How the panel groups and limits its rows. */
  get view(): ViewPrefs {
    return this.prefs;
  }

  /** Changes the view and keeps it; the rows themselves are not read again. */
  setView(patch: Partial<ViewPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    saveView(this.prefs);
    for (const l of [...this.listeners]) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes the query and reads the index again, without touching the logs. */
  setQuery(patch: Partial<SessionQuery>): Promise<void> {
    this.set({ query: { ...this.current.query, ...patch } });
    return this.read();
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

  /**
   * Reads the logs for new sessions, then the list. A call while a refresh runs shares it. A refresh
   * that takes long sets `reading` and fetches the rows it has read so far every `POLL_MS`.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
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
    this.stopPolling();
    this.listeners.clear();
    void this.unlisten?.then((stop) => stop()).catch(() => {});
  }

  private async runRefresh(): Promise<void> {
    const query = this.current.query;
    this.set({ loading: true });
    this.slow = setTimeout(() => {
      this.slow = null;
      this.set({ reading: true });
      void this.read();
      this.poll = setInterval(() => void this.read(), POLL_MS);
    }, READING_MS);
    try {
      const rows = await this.api.agentSessions(query, true);
      this.stopPolling();
      // A query changed meanwhile asks for its own rows; else these are the newest.
      if (this.current.query === query) await this.show(rows, ++this.serial);
      else await this.read();
    } catch (e) {
      this.stopPolling();
      if (this.current.query === query) this.set({ loading: false, error: toApiError(e) });
    } finally {
      this.set({ reading: false });
    }
  }

  private stopPolling(): void {
    if (this.slow) clearTimeout(this.slow);
    if (this.poll) clearInterval(this.poll);
    this.slow = this.poll = null;
  }

  /** Reads the index for the current query, without touching the logs. */
  private async read(): Promise<void> {
    const mine = ++this.serial;
    this.set({ loading: true });
    try {
      await this.show(await this.api.agentSessions(this.current.query, false), mine);
    } catch (e) {
      if (mine === this.serial) this.set({ loading: false, error: toApiError(e) });
    }
  }

  private async show(rows: SessionRow[], mine: number): Promise<void> {
    const contentSearch = await this.api.agentsSettings().then((s) => s.sessionSearch, () => false);
    // A newer read owns the state.
    if (mine !== this.serial) return;
    const homes = [...new Set([...this.current.homes, ...rows.map((r) => r.session.homeId)])].sort();
    this.set({ rows, loading: false, error: null, homes, contentSearch, more: rows.length >= this.current.query.limit });
  }

  private set(patch: Partial<AgentSessionsState>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
