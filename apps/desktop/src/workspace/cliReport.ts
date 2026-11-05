import type { Api, TabReport } from "@/api";
import type { Sessions, Tab } from "./sessions";

/** How long changes are gathered into one report. */
export const REPORT_THROTTLE_MS = 250;
/** How often output times are looked at, since output alone does not change a tab. */
export const REPORT_POLL_MS = 1000;
/** The most tabs one report carries; the backend keeps no more. */
export const REPORT_MAX = 500;

/** The four states the CLI knows; a failed turn has ended, an exited tab is idle with `exited`. */
export function cliStatus(tab: Pick<Tab, "status">): TabReport["status"] {
  switch (tab.status) {
    case "working":
    case "needs-you":
    case "done":
      return tab.status;
    case "failed":
      return "done";
    default:
      return "idle";
  }
}

/** Every tab as `xdev terminal list | wait` sees it. */
export function tabReports(sessions: Sessions): TabReport[] {
  return sessions
    .worktrees()
    .flatMap((w) => sessions.tabs(w))
    .slice(0, REPORT_MAX)
    .map((tab) => ({
      id: tab.id,
      worktree: tab.worktree,
      title: tab.title,
      profile: tab.profileId,
      agent: tab.agent,
      status: cliStatus(tab),
      lastOutputMs: sessions.lastOutput(tab.id) ?? 0,
      exited: tab.exitCode !== undefined,
      // For failover: the agent's provider, its account and how it ended (no code is a crash).
      ...(tab.cli ? { cli: tab.cli } : {}),
      ...(tab.account ? { account: tab.account } : {}),
      ...(typeof tab.exitCode === "number" ? { exitCode: tab.exitCode } : {}),
    }));
}

export interface CliReporter {
  /** Something outside the store changed (the selected worktree): report it with the next batch. */
  poke(): void;
  stop(): void;
}

/**
 * Tells the backend about the tabs: once at start, then at most every 250 ms while they change. An
 * unchanged report is not sent again. A failed call is dropped; the next change sends it all.
 */
export function startCliReport(api: Api, sessions: Sessions, selected: () => string | null): CliReporter {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    timer = null;
    const tabs = tabReports(sessions);
    const sel = selected();
    const key = JSON.stringify([tabs, sel]);
    if (key === last) return;
    last = key;
    void api.cliTabsReport(tabs, sel).catch(() => {});
  };
  const later = () => {
    if (timer === null) timer = setTimeout(send, REPORT_THROTTLE_MS);
  };
  send();
  const off = sessions.subscribe(later);
  const poll = setInterval(later, REPORT_POLL_MS);
  return {
    poke: later,
    stop() {
      off();
      clearInterval(poll);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
