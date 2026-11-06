import type { AgentSession, Api, ApiError, ForeignScan, ForeignTerm } from "./api";

type ForeignTermsApi = Pick<Api, "foreignTermsScan">;

const MINUTE_MS = 60_000;

function term(t: Partial<ForeignTerm> & Pick<ForeignTerm, "pid" | "name">): ForeignTerm {
  return { cwd: null, cwdIsDir: false, startMs: null, parentApp: null, agent: null, agentTitle: null, session: null, ...t };
}

/** Three outside rows: Claude in the demo repo whose session the index knows, Codex with none, and a shell. */
export function createMockForeignTerms(): ForeignTermsApi {
  return {
    async foreignTermsScan(): Promise<ForeignScan> {
      const now = Date.now();
      const session: AgentSession = {
        key: "own-claude:0b1e6f3a-demo-0001",
        id: "0b1e6f3a-demo-0001",
        homeId: "own-claude",
        agent: "claude",
        cwd: "/demo/xdev",
        branch: "main",
        title: "Fix the parser test on Windows paths",
        model: "claude-sonnet-5-5",
        first: now - 60 * MINUTE_MS,
        last: now - 20 * MINUTE_MS,
        messages: 24,
      };
      const rows = [
        term({ pid: 48211, name: "claude", cwd: "/demo/xdev", cwdIsDir: true, startMs: now - 65 * MINUTE_MS, parentApp: "Terminal", agent: "claude", agentTitle: "Claude Code", session }),
        term({ pid: 51034, name: "codex", cwd: "/demo/site", cwdIsDir: true, startMs: now - 12 * MINUTE_MS, parentApp: "Editor", agent: "codex", agentTitle: "Codex" }),
        term({ pid: 40102, name: "zsh", cwd: "/demo/gone", startMs: now - 3 * 60 * MINUTE_MS, parentApp: "Shell host" }),
      ];
      return { rows, truncated: false };
    },
  };
}

/** A scan that fails the way the real one does past its budget; for tests. */
export function failingForeignTerms(code: ApiError["code"] = "timeout"): ForeignTermsApi {
  return { foreignTermsScan: () => Promise.reject({ code } satisfies ApiError) };
}
