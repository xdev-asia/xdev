import type { Api } from "@/api";
import { clampTerminalSettings, getTerminalSettings, setTerminalSettings, TERMINAL_DEFAULTS } from "./terminalSettings";

export const FONT_STEP = 1;

/** True when a keyboard event came from inside an xterm element, i.e. a terminal has focus. */
export function eventInTerminal(e: Pick<KeyboardEvent, "target"> | undefined): boolean {
  const target = e?.target as { closest?: (selector: string) => unknown } | null | undefined;
  return typeof target?.closest === "function" && target.closest(".xterm") !== null;
}

/**
 * Changes the terminal font size by `delta` points (0 resets to the default), clamped to the stored
 * range, and writes it through the settings write path. Open panes follow the shared copy at once.
 * Returns the size now in effect; a failed write keeps the size shown.
 */
export async function stepTerminalFont(api: Pick<Api, "terminalSettingsPut">, delta: number): Promise<number> {
  const before = getTerminalSettings();
  const wanted = delta === 0 ? TERMINAL_DEFAULTS.fontSize : before.fontSize + delta;
  const next = clampTerminalSettings({ ...before, fontSize: wanted });
  if (next.fontSize === before.fontSize) return before.fontSize;
  setTerminalSettings(next);
  try {
    setTerminalSettings(await api.terminalSettingsPut(next));
  } catch {
    // The new size stays on screen for this run; the next successful write stores it.
  }
  return getTerminalSettings().fontSize;
}
