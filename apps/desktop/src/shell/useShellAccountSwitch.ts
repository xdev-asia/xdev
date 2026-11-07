import { useState } from "react";
import { profileName } from "@/agents/profileStore";
import { toApiError, type Api, type Provider } from "@/api";
import type { useI18n } from "@/i18n";
import type { SwitchScope, SwitchTab } from "@/workspace/AccountSwitchDialog";
import { restartTabs } from "@/workspace/accountSwitchFlow";
import type { Sessions, Tab } from "@/workspace/sessions";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

export function useShellAccountSwitch(o: { api: Api; sessions: Sessions | null; t: T; live: { t: T }; frontTab(): Tab | null }) {
  const { api, sessions, t, live } = o;
  // "Use" on an account in the usage popover. Running tabs keep their account; with an agent tab of that
  // provider in front, the dialog asks whether it moves that tab or the default for new tabs.
  const [switching, setSwitching] = useState<{ provider: Provider; to: string; tab: SwitchTab } | null>(null);
  const setDefaultAccount = (provider: Provider, name: string) =>
    void api.accountActivate(provider, name).catch((e) => pushToast({ text: t("accounts.switch.failed", { code: toApiError(e).code }) }));
  function pickAccount(provider: Provider, name: string): void {
    const front = o.frontTab();
    if (!front || front.cli !== provider || front.account === name) return setDefaultAccount(provider, name);
    const label = `${front.title ?? profileName(null, front.profileId, t)} · ${front.worktree.split(/[\\/]/).filter(Boolean).pop() ?? front.worktree}`;
    setSwitching({ provider, to: name, tab: { id: front.id, label, account: front.account, working: front.status === "working" } });
  }
  function answerSwitch(scope: SwitchScope): void {
    const pending = switching;
    setSwitching(null);
    if (!pending) return;
    if (scope === "default") return setDefaultAccount(pending.provider, pending.to);
    if (!sessions) return;
    // The tab's conversation is carried to the new account's home, then it restarts there.
    const move = { provider: pending.provider, from: pending.tab.account, to: pending.to, tabIds: [pending.tab.id] };
    void restartTabs({ api, sessions, notify: (key, vars) => pushToast({ text: live.t(key, vars) }) }, move, move.tabIds);
  }

  return { switching, setSwitching, pickAccount, answerSwitch };
}
