import type { AgentsSettings, Api, UsageSettings, DiffSettings, EditorSettings, KeySettings, NavigationSettings, SettingsChanged, SettingsSection, SidebarPrefs, TerminalSettings, UiSettings } from "./api";
import { clampEditorSettings, EDITOR_DEFAULTS } from "./files/editorDefaults";
import { KEY_SETTINGS_DEFAULTS } from "./keys/bindingsStore";
import { DIFF_DEFAULTS, NAVIGATION_DEFAULTS } from "./settings/generalDefaults";
import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS, USAGE_DEFAULTS } from "./settings/usageDefaults";
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
  | "sidebarPrefsGet"
  | "sidebarPrefsPut"
  | "navigationSettings"
  | "navigationSettingsPut"
  | "diffSettings"
  | "diffSettingsPut"
  | "agentsSettings"
  | "agentsSettingsPut"
  | "usageSettings"
  | "usageSettingsPut"
>;

/** `SidebarPrefs::default()` in Rust: every row shows. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = { hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false };

export { KEY_SETTINGS_DEFAULTS };
/** `UiSettings::default()` in Rust, and the range `ui_settings_put` clamps the zoom to. */
export const UI_SETTINGS_DEFAULTS: UiSettings = { zoom: 1, restore: "all" };
export const ZOOM_LIMITS = { min: 0.5, max: 2 } as const;

export { DIFF_DEFAULTS, NAVIGATION_DEFAULTS, USAGE_DEFAULTS };
/** `AgentsSettings::default()` in Rust: a switch asks about running tabs. */
export const AGENTS_SETTINGS_DEFAULTS: AgentsSettings = { accountSwitch: "ask" };

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
  let sidebar: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS };
  let navigation: NavigationSettings = { ...NAVIGATION_DEFAULTS };
  let diff: DiffSettings = { ...DIFF_DEFAULTS };
  let agents: AgentsSettings = { ...AGENTS_SETTINGS_DEFAULTS };
  let usage: UsageSettings = structuredClone(USAGE_DEFAULTS);
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
    async sidebarPrefsGet() {
      return { ...sidebar };
    },
    async sidebarPrefsPut(next) {
      sidebar = { ...SIDEBAR_PREFS_DEFAULTS, ...next };
      hub.emit(["sidebar"]);
      return { ...sidebar };
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
    async agentsSettings() {
      return { ...agents };
    },
    async agentsSettingsPut(next) {
      agents = { ...AGENTS_SETTINGS_DEFAULTS, ...next };
      hub.emit(["agents"]);
      return { ...agents };
    },
    async usageSettings() {
      return structuredClone(usage);
    },
    async usageSettingsPut(next) {
      // Rust turns a cache lifetime that is not one of the two known ones into the short one.
      usage = structuredClone({ ...next, cacheTtlMs: next.cacheTtlMs === CACHE_TTL_LONG_MS ? CACHE_TTL_LONG_MS : CACHE_TTL_SHORT_MS });
      hub.emit(["usage"]);
      return structuredClone(usage);
    },
  };
}
