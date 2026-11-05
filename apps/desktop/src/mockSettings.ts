import type { NetworkSettings, AgentsSettings, OrchestrationSettings, Api, AutomationsSettings, UsageSettings, DiffSettings, EditorSettings, KeySettings, NavigationSettings, SettingsChanged, SettingsSection, CardProps, SidebarPrefs, TerminalSettings, UiSettings } from "./api";
import { clampEditorSettings, EDITOR_DEFAULTS } from "./files/editorDefaults";
import { knownAppIcon } from "./ui/appIcon";
import { KEY_SETTINGS_DEFAULTS } from "./keys/bindingsStore";
import { AUTOMATIONS_DEFAULTS, DIFF_DEFAULTS, NAVIGATION_DEFAULTS } from "./settings/generalDefaults";
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
  | "appIconSet"
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
  | "orchestrationSettings"
  | "orchestrationSettingsPut"
  | "usageSettings"
  | "usageSettingsPut"
  | "automationsSettings"
  | "automationsSettingsPut"
  | "networkSettings"
  | "networkSettingsPut"
  | "machineName"
>;

/** `CardProps::default()` in Rust: every card property shows. */
export const CARD_PROPS_DEFAULTS: CardProps = {
  branch: true,
  time: true,
  comment: true,
  workStatus: true,
  workItem: true,
  agents: true,
  diffStat: true,
  pr: true,
  projectChip: true,
  ports: true,
};

/** `SidebarPrefs::default()` in Rust: every row shows, in the agent sections, as detailed cards. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  hideDefault: false,
  hideDetached: false,
  hideAutomation: false,
  hideCli: false,
  groupBy: "activity",
  sort: "manual",
  compactCards: false,
  card: CARD_PROPS_DEFAULTS,
  projectOrder: "manual",
  pinnedInGroups: false,
  projectFilter: [],
  externalDefaultHidden: true,
  hiddenWorktrees: [],
  shownWorktrees: [],
};

export { KEY_SETTINGS_DEFAULTS };
/** `UiSettings::default()` in Rust, and the range `ui_settings_put` clamps the zoom to. */
export const UI_SETTINGS_DEFAULTS: UiSettings = {
  zoom: 1,
  restore: "all",
  theme: "system",
  uiFont: "",
  editorThemeLight: "app",
  editorThemeDark: "app",
  sidebar: "default",
  sidebarTint: "",
  sidebarTintOpacity: 0.1,
  reduceEffects: false,
  hiddenApps: [],
  statusBar: { branch: true, tokenUsage: true, agents: true, version: true, ports: true, keepAwake: true },
  titlebar: "native",
  showTitlebarName: true,
  appIcon: "default",
};
/** `UI_FONT_MAX` in Rust. */
export const UI_FONT_MAX = 120;

/** `clean_ui_font` in Rust: control characters dropped, trimmed, cut to `UI_FONT_MAX` characters. */
export function cleanUiFont(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const kept = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return Array.from(kept).slice(0, UI_FONT_MAX).join("").trim();
}
export const ZOOM_LIMITS = { min: 0.5, max: 2 } as const;

export { DIFF_DEFAULTS, NAVIGATION_DEFAULTS, USAGE_DEFAULTS };
/** `AgentsSettings::default()` in Rust: a switch asks about running tabs. */
export const AGENTS_SETTINGS_DEFAULTS: AgentsSettings = {
  accountSwitch: "ask",
  keepAwake: "off",
  autoTabTitle: false,
  autoSleep: false,
  sleepAfterMin: 30,
  sessionSearch: false,
  workspaceTrust: true,
};

/** `OrchestrationSettings::default()` in Rust, and the range the depth is clamped to. */
export const ORCHESTRATION_DEFAULTS: OrchestrationSettings = {
  nestedWorkerMaxDepth: 1,
  workerAutoClose: true,
  failoverEnabled: false,
  failoverBackupAccount: true,
  failoverBackupAgents: [],
  failoverMax: 2,
  autopilotRestart: false,
  stuckMinutes: 10,
};
export const NESTED_DEPTH_LIMITS = { min: 1, max: 9 } as const;
/** `FAILOVER_MAX`, `STUCK_MINUTES_MAX` and `BACKUP_AGENTS_MAX` in Rust. */
export const FAILOVER_LIMITS = { max: 5, stuckMax: 120, agents: 8 } as const;

const whole = (v: number, fallback: number): number => (Number.isFinite(v) ? Math.trunc(v) : fallback);

/** The backup agents as Rust keeps them: trimmed, without blanks or repeats, at most 8. */
export function backupAgents(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of list.map((x) => x.trim())) if (a && !out.includes(a) && out.length < FAILOVER_LIMITS.agents) out.push(a);
  return out;
}

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
  let orchestration: OrchestrationSettings = { ...ORCHESTRATION_DEFAULTS };
  let usage: UsageSettings = structuredClone(USAGE_DEFAULTS);
  let automations: AutomationsSettings = { ...AUTOMATIONS_DEFAULTS };
  let network: NetworkSettings = { proxyUrl: "", noProxy: [], nodeMirror: "", machineName: "" };
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
      ui = {
        ...UI_SETTINGS_DEFAULTS,
        ...next,
        zoom: Math.max(ZOOM_LIMITS.min, Math.min(ZOOM_LIMITS.max, zoom)),
        uiFont: cleanUiFont(next.uiFont ?? ""),
        statusBar: { ...UI_SETTINGS_DEFAULTS.statusBar, ...next.statusBar },
        appIcon: knownAppIcon(next.appIcon ?? ""),
      };
      hub.emit(["ui"]);
      return { ...ui };
    },
    async appIconSet(id) {
      ui = { ...ui, appIcon: knownAppIcon(id) };
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
    async orchestrationSettings() {
      return { ...orchestration };
    },
    async orchestrationSettingsPut(next) {
      const depth = Number.isFinite(next.nestedWorkerMaxDepth) ? Math.trunc(next.nestedWorkerMaxDepth) : ORCHESTRATION_DEFAULTS.nestedWorkerMaxDepth;
      orchestration = {
        nestedWorkerMaxDepth: Math.max(NESTED_DEPTH_LIMITS.min, Math.min(NESTED_DEPTH_LIMITS.max, depth)),
        workerAutoClose: next.workerAutoClose,
        failoverEnabled: next.failoverEnabled,
        failoverBackupAccount: next.failoverBackupAccount,
        failoverBackupAgents: backupAgents(next.failoverBackupAgents),
        failoverMax: Math.max(0, Math.min(FAILOVER_LIMITS.max, whole(next.failoverMax, ORCHESTRATION_DEFAULTS.failoverMax))),
        autopilotRestart: next.autopilotRestart,
        stuckMinutes: Math.max(1, Math.min(FAILOVER_LIMITS.stuckMax, whole(next.stuckMinutes, ORCHESTRATION_DEFAULTS.stuckMinutes))),
      };
      hub.emit(["orchestration"]);
      return { ...orchestration };
    },
    async automationsSettings() {
      return { ...automations };
    },
    async automationsSettingsPut(next) {
      automations = { ...AUTOMATIONS_DEFAULTS, ...next };
      hub.emit(["automations"]);
      return { ...automations };
    },
    async networkSettings() {
      return { ...network, noProxy: [...network.noProxy] };
    },
    async networkSettingsPut(next) {
      network = { ...next, noProxy: [...next.noProxy] };
      hub.emit(["network"]);
      return { ...network, noProxy: [...network.noProxy] };
    },
    async machineName() {
      return network.machineName.trim() || "this-machine";
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
