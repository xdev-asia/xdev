import type { Accounts, ProviderSwitches, Quota, UsageSettings } from "@/api";
import type { MenuItem } from "@/ui/ContextMenu";

export const EMPTY_CTA_KEY = "xdev.usage.emptyCta.hidden";

// The providers with a footer meter; the others have no quota source to show.
const PROVIDERS: (keyof ProviderSwitches)[] = ["claude", "codex"];

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

/** The settings with every footer meter off: the same switches Settings > Usage footer meters writes. */
export function hiddenFooterSettings(usage: UsageSettings): UsageSettings {
  return { ...usage, footer: { ...usage.footer, claude: false, codex: false } };
}

/** Turns every footer meter off, and once that is saved offers `announce` the way back: the earlier settings. */
export function hideUsageSegment(usage: UsageSettings, put: (next: UsageSettings, saved?: () => void) => void, announce: (undo: () => void) => void): void {
  put(hiddenFooterSettings(usage), () => announce(() => put(usage)));
}

/** The top of the right-click menu on the usage segment: hide it, or go to the accounts. */
export function segmentMenuItems(hide: () => void, manage?: () => void): MenuItem[] {
  const items: MenuItem[] = [{ id: "hide", labelKey: "usage.menu.hide", run: hide }];
  if (manage) items.push({ id: "manage", labelKey: "usage.menu.manage", run: manage });
  return items;
}

/** Shift+F10 and the context-menu key open the menu from the keyboard. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
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
