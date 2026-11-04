import { PROVIDERS, type Api, type Provider } from "@/api";
import { affectedTabs } from "./accountSwitch";
import type { Sessions } from "./sessions";

/** The tabs a switch left under the old account, for the person to choose from. */
export interface PendingSwitch {
  provider: Provider;
  /** The active account before and after; null is the CLI's own home. */
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

const allTabs = (sessions: Sessions) => sessions.worktrees().flatMap((w) => sessions.tabs(w));

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

/**
 * Watches `accounts://changed`: when the active account of a provider changes (from Accounts, the usage
 * popover, or a removal), the agent tabs that follow it are handled by the `agents.accountSwitch` policy:
 * Keep does nothing, Restart restarts them all, Ask hands them to `ask` for the dialog. Returns `stop`.
 */
export function watchAccountSwitch(options: SwitchDeps & { ask(pending: PendingSwitch): void }): { stop(): void } {
  const { api, sessions } = options;
  let stopped = false;
  let known: Map<Provider, string | null> | null = null;
  const read = async () => {
    const found = await api.accounts();
    return new Map(PROVIDERS.map((p): [Provider, string | null] => [p, found.active.find((a) => a.provider === p)?.name ?? null]));
  };
  const ready = read().then(
    (map) => {
      known ??= map;
    },
    () => {},
  );

  async function handle(): Promise<void> {
    await ready;
    const next = await read();
    const before = known;
    known = next;
    if (stopped || !before) return;
    for (const provider of PROVIDERS) {
      const from = before.get(provider) ?? null;
      const to = next.get(provider) ?? null;
      if (from === to) continue;
      const tabIds = affectedTabs(allTabs(sessions), provider, from).map((t) => t.id);
      if (tabIds.length === 0) continue;
      const policy = (await api.agentsSettings().catch(() => null))?.accountSwitch ?? "ask";
      const pending: PendingSwitch = { provider, from, to, tabIds };
      if (policy === "restart") await restartTabs(options, pending, tabIds);
      else if (policy === "ask") options.ask(pending);
    }
  }

  // One change at a time, so two quick switches do not read each other's state.
  let chain: Promise<void> = Promise.resolve();
  const unlisten = api.onAccountsChanged(() => {
    chain = chain.then(handle).catch(() => {});
  });
  return {
    stop() {
      stopped = true;
      void unlisten.then((off) => off(), () => {});
    },
  };
}
