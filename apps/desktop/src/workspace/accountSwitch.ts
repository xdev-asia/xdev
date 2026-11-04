import type { Provider } from "@/api";
import type { Tab } from "./sessions";

/**
 * The tabs a switch of the active account of `provider` leaves running under `oldAccount`: agent tabs
 * that started under the active account (not their own pick, not the profile's), same CLI, same account.
 */
export function affectedTabs(tabs: Tab[], provider: Provider, oldAccount: string | null): Tab[] {
  return tabs.filter((t) => t.agent && t.accountSource === "active" && t.cli === provider && t.account === oldAccount);
}
