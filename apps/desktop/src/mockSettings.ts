import type { Api, SettingsChanged, SettingsSection, TerminalSettings } from "./api";
import { clampTerminalSettings, TERMINAL_DEFAULTS } from "./settings/terminalDefaults";

/** Called by a mock's settings write, the way Rust emits `settings://changed`. */
export type SettingsEmit = (sections: SettingsSection[]) => void;

type SettingsApi = Pick<Api, "onSettingsChanged" | "terminalSettings" | "terminalSettingsPut">;

export type SettingsHub = { emit: SettingsEmit; onSettingsChanged: Api["onSettingsChanged"] };

/** The `settings://changed` listeners of one mock api; `emit` calls them synchronously. */
export function createSettingsHub(): SettingsHub {
  const listeners = new Set<(e: SettingsChanged) => void>();
  return {
    emit(sections) {
      for (const listener of [...listeners]) listener({ sections: [...sections] });
    },
    onSettingsChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Settings → Terminal in memory, clamped like Rust stores it. */
export function createMockSettings(hub: SettingsHub = createSettingsHub()): SettingsApi {
  let terminal: TerminalSettings = { ...TERMINAL_DEFAULTS };
  return {
    onSettingsChanged: hub.onSettingsChanged,
    async terminalSettings() {
      return { ...terminal };
    },
    async terminalSettingsPut(next) {
      terminal = clampTerminalSettings(next);
      hub.emit(["terminal"]);
      return { ...terminal };
    },
  };
}
