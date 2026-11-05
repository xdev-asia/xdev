import type { AgentSession, AgentsSettings, Api, ApiError, SessionQuery, SessionRow } from "./api";

/** The agents settings the search reads its consent from, and the one write a clear makes. */
export interface SearchConsent {
  agentsSettings(): Promise<AgentsSettings>;
  agentsSettingsPut(next: AgentsSettings): Promise<AgentsSettings>;
}

type AgentSessionsApi = Pick<Api, "agentSessions" | "sessionSearchStatus" | "sessionSearchClear">;

const LIMIT_MAX = 500;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

function row(
  over: Partial<AgentSession> & Pick<AgentSession, "id" | "agent" | "cwd" | "title">,
  worktree: string | null,
  repo: string | null,
  ago: number,
  length: number,
  resumable = true,
  transcript: string[] = [],
): (now: number) => SessionRow & { transcript: string[] } {
  return (now) => {
    const homeId = over.homeId ?? `own-${over.agent}`;
    const last = now - ago;
    const session: AgentSession = {
      key: `${homeId}:${over.id}`,
      homeId,
      branch: null,
      model: over.agent === "claude" ? "claude-sonnet-5-5" : "gpt-5",
      first: last - length,
      last,
      messages: 12,
      ...over,
    };
    return { session, worktree, repo, resumable, transcript };
  };
}

// Two repos: the demo workspace's xdev (main and two worktrees) and a site repo, plus a session
// run in a folder no repo holds.
const ROWS: Array<(now: number) => SessionRow & { transcript: string[] }> = [
  row({ id: "0b1e6f3a-demo-0001", agent: "claude", cwd: "/demo/xdev", branch: "main", title: "Fix the parser test on Windows paths", messages: 24 }, "/demo/xdev", "/demo/xdev", 20 * 60_000, 40 * 60_000, true, ["The backslash in the fixture path breaks the glob", "Normalising separators before matching fixes it"]),
  row({ id: "01a1a18f-demo-0002", agent: "codex", cwd: "/demo/wt/xdev-oak", branch: "oak", title: "Add the session history panel" }, "/demo/wt/xdev-oak", "/demo/xdev", 3 * HOUR_MS, HOUR_MS, true, ["Group the history by day and add a resume button"]),
  row({ id: "7c2d9e10-demo-0003", agent: "claude", cwd: "/demo/wt/xdev-elm/src", branch: "elm", title: "Review the status hook events" }, "/demo/wt/xdev-elm", "/demo/xdev", DAY_MS + 2 * HOUR_MS, 30 * 60_000, true, ["The hook events arrive out of order after a restart"]),
  row({ id: "3f4a5b6c-demo-0004", agent: "claude", homeId: "acct-claude-2", cwd: "/demo/xdev", branch: "main", title: "Write release notes for 0.5" }, "/demo/xdev", "/demo/xdev", 2 * DAY_MS, 20 * 60_000),
  row({ id: "8d9e0f1a-demo-0005", agent: "codex", cwd: "/demo/site", branch: "main", title: "Update the landing page copy" }, "/demo/site", "/demo/site", 3 * DAY_MS, HOUR_MS),
  row({ id: "9e0f1a2b-demo-0006", agent: "claude", cwd: "/demo/site", branch: "docs", title: null, messages: 0 }, "/demo/site", "/demo/site", 6 * DAY_MS, 5 * 60_000),
  row({ id: "a0b1c2d3-demo-0007", agent: "claude", cwd: "/demo/tmp/scratch", title: "Try a regex for log lines" }, null, null, 9 * DAY_MS, 10 * 60_000, false),
];

const inside = (path: string | null | undefined, root: string) => !!path && (path === root || path.startsWith(`${root}/`));

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The first transcript line that holds every word, with the words in `<mark>`, like the Rust snippet. */
function hitOf(transcript: string[], words: string[]): string | undefined {
  if (words.length === 0) return undefined;
  const line = transcript.find((l) => words.every((w) => l.toLowerCase().includes(w)));
  if (!line) return undefined;
  let out = escape(line);
  for (const w of words) out = out.replace(new RegExp(`(${regexEscape(w)})`, "ig"), "<mark>$1</mark>");
  return out;
}

function matches(row: SessionRow, words: string[]): boolean {
  const s = row.session;
  const fields = [s.title, s.cwd, s.branch, s.model].map((f) => (f ?? "").toLowerCase());
  const id = s.id.toLowerCase();
  return words.every((w) => fields.some((f) => f.includes(w)) || id.startsWith(w));
}

/** A fixed list of sessions across two repos, filtered, sorted and cut like Rust does. */
export function createMockAgentSessions(consent: SearchConsent, now: () => number = () => Date.now()): AgentSessionsApi {
  return {
    async sessionSearchStatus() {
      const enabled = (await consent.agentsSettings()).sessionSearch;
      if (!enabled) return { enabled, sessions: 0, messages: 0, updatedAt: null, indexing: false };
      const t = now();
      const rows = ROWS.map((make) => make(t)).filter((r) => r.transcript.length > 0);
      return { enabled, sessions: rows.length, messages: rows.reduce((n, r) => n + r.transcript.length, 0), updatedAt: t, indexing: false };
    },
    async sessionSearchClear() {
      return consent.agentsSettingsPut({ ...(await consent.agentsSettings()), sessionSearch: false });
    },
    async agentSessions(query: SessionQuery, _refresh: boolean) {
      if (query.limit > LIMIT_MAX) return reject("bad_arg", "limit");
      const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const scope = query.scope;
      const t = now();
      const searching = (await consent.agentsSettings()).sessionSearch;
      const found = new Map<string, string>();
      const rows = ROWS.map((make) => make(t)).filter((r) => {
        if (scope.kind === "worktree" && !inside(r.session.cwd, scope.path)) return false;
        if (scope.kind === "repo" && r.repo !== scope.path) return false;
        if (query.agent && r.session.agent !== query.agent) return false;
        if (query.homeId && r.session.homeId !== query.homeId) return false;
        const hit = searching ? hitOf(r.transcript, words) : undefined;
        if (hit) found.set(r.session.key, hit);
        return hit !== undefined || matches(r, words);
      });
      const key = query.sort === "firstDesc" ? (r: SessionRow) => r.session.first : (r: SessionRow) => r.session.last;
      rows.sort((a, b) => key(b) - key(a));
      return rows.slice(0, query.limit).map(({ transcript: _t, ...r }) => {
        const hit = found.get(r.session.key);
        return structuredClone(hit === undefined ? r : { ...r, hit });
      });
    },
  };
}
