import type { Api } from "@/api";
import type { Sessions } from "@/workspace/sessions";

/** What the report loop reads: how many agent tabs work, and when that may have changed. */
export interface ReportSource {
  workingAgents(): number;
  subscribe(listener: () => void): () => void;
}

/** The sessions of the workspace as a report source: agent tabs in the `working` status, over every worktree. */
export function sessionsSource(sessions: Sessions): ReportSource {
  return {
    workingAgents: () => sessions.worktrees().reduce((n, path) => n + sessions.tabs(path).filter((tab) => tab.agent && tab.status === "working").length, 0),
    subscribe: (listener) => sessions.subscribe(listener),
  };
}

/**
 * Tells the app each time "an agent is working" turns true or false, and nothing in between.
 * Stopping says `false`, so a closed window does not keep the computer awake.
 */
export function startAgentsReport(source: ReportSource, report: (working: boolean) => void | Promise<unknown>): () => void {
  let last = false;
  const send = (working: boolean) => {
    try {
      void Promise.resolve(report(working)).catch(() => {});
    } catch {
      // The report is best effort: the next change sends it again.
    }
  };
  const check = () => {
    const now = source.workingAgents() > 0;
    if (now === last) return;
    last = now;
    send(now);
  };
  const off = source.subscribe(check);
  check();
  return () => {
    off();
    if (last) {
      last = false;
      send(false);
    }
  };
}

/** The loop of the workspace: the sessions report to `api.keepAwakeAgents`. */
export function startKeepAwakeReport(api: Pick<Api, "keepAwakeAgents">, sessions: Sessions): () => void {
  return startAgentsReport(sessionsSource(sessions), (working) => api.keepAwakeAgents(working));
}
