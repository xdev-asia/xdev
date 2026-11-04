import type { Tab } from "./sessions";

/**
 * The account to start a tab's pty with: only one the tab itself picked. An account that came from the
 * profile or the active account is looked up again at each start, so a restart keeps following it.
 */
export function ownAccount(tab: Pick<Tab, "account" | "accountSource">): string | null {
  return tab.accountSource === "profile" || tab.accountSource === "active" ? null : tab.account;
}
