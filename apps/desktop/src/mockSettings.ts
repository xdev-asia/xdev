import type { Api, DiffSettings, EditorSettings, KeySettings, NavigationSettings, SettingsChanged, SettingsSection, TerminalSettings, UiSettings } from "./api";
import { clampEditorSettings, EDITOR_DEFAULTS } from "./files/editorDefaults";
import { KEY_SETTINGS_DEFAULTS } from "./keys/bindingsStore";
import { clampTerminalSettings, TERMINAL_DEFAULTS } from "./settings/terminalDefaults";

/** Called by a mock's settings write, the way Rust emits `settings://changed`. */
export type SettingsEmit = (sections: SettingsSection[]) => void;

type SettingsApi = Pick<
  Api,
  | "onSettingsChanged"
  | "terminalSettings"
  | "terminalSettingsPut"
  | "keySettingsGet"
  | "keySettingsPut"
  | "uiSettingsGet"
  | "uiSettingsPut"
  | "editorSettings"
  | "editorSettingsPut"
  | "navigationSettings"
  | "navigationSettingsPut"
  | "diffSettings"
  | "diffSettingsPut"
>;

export { KEY_SETTINGS_DEFAULTS };
/** `UiSettings::default()` in Rust, and the range `ui_settings_put` clamps the zoom to. */
export const UI_SETTINGS_DEFAULTS: UiSettings = { zoom: 1, restore: "all" };
export const ZOOM_LIMITS = { min: 0.5, max: 2 } as const;

/** `NavigationSettings::default()` in Rust. */
export const NAVIGATION_DEFAULTS: NavigationSettings = {
  tabOrder: "mru",
  confirmClosePinned: true,
  confirmCloseRunning: true,
  askBeforeDeleteWorktree: true,
};
/** `DiffSettings::default()` in Rust. */
export const DIFF_DEFAULTS: DiffSettings = {
  defaultView: "inline",
  ignoreWhitespace: false,
  collapseUnchanged: true,
  wordWrap: false,
  fileTree: false,
};

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

/** Settings → Terminal, Keys, Editor and the view settings in memory, clamped like Rust stores them. */
export function createMockSettings(hub: SettingsHub = createSettingsHub()): SettingsApi {
  let terminal: TerminalSettings = { ...TERMINAL_DEFAULTS };
  let keys: KeySettings = { ...KEY_SETTINGS_DEFAULTS };
  let ui: UiSettings = { ...UI_SETTINGS_DEFAULTS };
  let editor: EditorSettings = { ...EDITOR_DEFAULTS };
  let navigation: NavigationSettings = { ...NAVIGATION_DEFAULTS };
  let diff: DiffSettings = { ...DIFF_DEFAULTS };
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
    async keySettingsGet() {
      return { ...keys };
    },
    async keySettingsPut(next) {
      keys = { ...next };
      hub.emit(["keys"]);
      return { ...keys };
    },
    async uiSettingsGet() {
      return { ...ui };
    },
    async uiSettingsPut(next) {
      const zoom = Number.isFinite(next.zoom) ? next.zoom : UI_SETTINGS_DEFAULTS.zoom;
      ui = { zoom: Math.max(ZOOM_LIMITS.min, Math.min(ZOOM_LIMITS.max, zoom)), restore: next.restore };
      hub.emit(["ui"]);
      return { ...ui };
    },
    async editorSettings() {
      return { ...editor };
    },
    async editorSettingsPut(next) {
      editor = clampEditorSettings(next);
      hub.emit(["editor"]);
      return { ...editor };
    },
    async navigationSettings() {
      return { ...navigation };
    },
    async navigationSettingsPut(next) {
      navigation = { ...next };
      hub.emit(["navigation"]);
      return { ...navigation };
    },
    async diffSettings() {
      return { ...diff };
    },
    async diffSettingsPut(next) {
      diff = { ...next };
      hub.emit(["diff"]);
      return { ...diff };
    },
  };
}
