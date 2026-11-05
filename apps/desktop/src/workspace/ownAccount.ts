import type { Tab } from "./sessions";

/**
 * The account a tab's terminal starts its pty with: only one the tab was started on by name. It stays
 * the same once the pty reports where the account came from, so the terminal does not start twice.
 */
export function ownAccount(tab: Pick<Tab, "account" | "accountSource">): string | null {
  return tab.accountSource === "profile" || tab.accountSource === "active" || tab.accountSource === "routed" ? null : tab.account;
}

/**
 * The account a restart, a wake, a sleep or a reopen starts the tab on: the one it ran under, so it
 * stays there whatever the default is now. Only a profile's account is looked up again.
 */
export function runAccount(tab: Pick<Tab, "account" | "accountSource">): string | null {
  return tab.accountSource === "profile" ? null : tab.account;
}
