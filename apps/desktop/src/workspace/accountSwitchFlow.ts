import type { Api, Provider } from "@/api";
import type { Sessions } from "./sessions";

/** Tabs to move from one account to another. */
export interface PendingSwitch {
  provider: Provider;
  /** The account they run under and the one they move to; null is the CLI's own home. */
  from: string | null;
  to: string | null;
  tabIds: string[];
}

export interface SwitchDeps {
  api: Api;
  sessions: Sessions;
  /** Says something in a toast: an i18n key and its values. */
  notify(key: string, vars?: Record<string, string | number>): void;
}

/**
 * Restarts the tabs `ids` of `pending` under the new account. An agent tab with a session id gets its
 * session log copied into the new account's home first and resumes it; when the copy fails the tab
 * starts a fresh conversation and a toast says so. Tabs that are gone by now are skipped.
 */
export async function restartTabs(deps: SwitchDeps, pending: PendingSwitch, ids: readonly string[]): Promise<void> {
  const { api, sessions, notify } = deps;
  for (const id of ids) {
    const tab = sessions.tab(id);
    if (!tab) continue;
    let fresh = false;
    const session = tab.agentSession ?? tab.resumeOf;
    if (session !== null) {
      try {
        await api.accountCarrySession(pending.provider, pending.from, pending.to, session, tab.worktree);
      } catch {
        fresh = true;
        notify("accounts.switch.carryFailed", { tab: tab.title ?? tab.profileId });
      }
    }
    // The tab may have closed or moved on while the copy ran.
    if (sessions.tab(id)) sessions.restartAs(id, pending.to, fresh);
  }
}
