export interface SettingsAt {
  section?: string;
  arg?: string;
  target?: string;
  seq: number;
}

/**
 * Asking for the Settings view while it already shows the same section, arg and target (with
 * `toggle`) closes it; any other ask opens it at the new place. The gear opens the first section,
 * so a plain gear click with Settings open at another place still opens, never toggles.
 */
export function settingsIntent(
  current: SettingsAt,
  viewIsSettings: boolean,
  next: { section?: string; arg?: string; target?: string },
  toggle: boolean,
): { close: true } | { close: false; at: SettingsAt } {
  if (toggle && viewIsSettings && current.section === next.section && current.arg === next.arg && current.target === next.target) {
    return { close: true };
  }
  return { close: false, at: { ...next, seq: current.seq + 1 } };
}
