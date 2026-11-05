import type { Accounts, Provider, Quota, UsageSettings } from "@/api";
import type { MenuItem } from "@/ui/ContextMenu";

export const EMPTY_CTA_KEY = "xdev.usage.emptyCta.hidden";

const PROVIDERS: Provider[] = ["claude", "codex"];

/** The right-click menu of the footer meters: one switch per provider, then a way to the usage settings. */
export function usageMenuItems(usage: UsageSettings, put: (next: UsageSettings) => void, openSettings?: () => void): MenuItem[] {
  const items: MenuItem[] = PROVIDERS.map((p) => ({
    id: `footer.${p}`,
    labelKey: `settings.usage.footer.${p}`,
    checked: usage.footer[p],
    run: () => put({ ...usage, footer: { ...usage.footer, [p]: !usage.footer[p] } }),
  }));
  if (openSettings) {
    items.push({ id: "sep", labelKey: "", kind: "separator" }, { id: "settings", labelKey: "usage.menu.settings", run: openSettings });
  }
  return items;
}

/** Whether the person hid the set-up link; false when nothing is saved or storage cannot be read. */
export function loadEmptyCtaHidden(): boolean {
  try {
    return localStorage.getItem(EMPTY_CTA_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveEmptyCtaHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(EMPTY_CTA_KEY, "1");
    else localStorage.removeItem(EMPTY_CTA_KEY);
  } catch {
    // The choice only fails to survive a restart.
  }
}

/** The set-up link shows only when nothing is set up: no account, and both reads finished. */
export function showEmptyCta(quota: Quota[] | null, accounts: Accounts | null, hidden: boolean): boolean {
  return !hidden && quota !== null && quota.length === 0 && accounts !== null && accounts.accounts.length === 0;
}
