import type { Api, NotchTab } from "@/api";
import { profileName } from "@/agents/profileStore";
import type { Sessions } from "@/workspace/sessions";

/** How long changes are gathered into one report. */
export const NOTCH_THROTTLE_MS = 250;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The agent tabs as the strip sees them; named by hand or by profile, never by the prompt. */
export function notchTabs(sessions: Pick<Sessions, "worktrees" | "tabs">, t: T): NotchTab[] {
  return sessions
    .worktrees()
    .flatMap((w) => sessions.tabs(w))
    .filter((tab) => tab.agent)
    .map((tab) => ({
      ptyId: tab.id,
      status: tab.status,
      name: tab.renamed && tab.title ? tab.title : profileName(null, tab.profileId, t),
      worktree: tab.worktree,
    }));
}

/**
 * Tells the backend about the agent tabs for the notch strip: once at start, then at most every
 * 250 ms while they change. An unchanged list is not sent again; a failed call waits for the next change.
 */
export function startNotchReport(
  api: Pick<Api, "notchReport">,
  sessions: Pick<Sessions, "worktrees" | "tabs" | "subscribe">,
  t: T,
): () => void {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    timer = null;
    const tabs = notchTabs(sessions, t);
    const key = JSON.stringify(tabs);
    if (key === last) return;
    last = key;
    void Promise.resolve(api.notchReport(tabs)).catch(() => {
      last = "";
    });
  };
  send();
  const off = sessions.subscribe(() => {
    if (timer === null) timer = setTimeout(send, NOTCH_THROTTLE_MS);
  });
  return () => {
    off();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
