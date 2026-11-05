import type { Api, CloseIntent, CloseRequest, HelpLink, MenuAction, QuitMode, ReleaseBuild, ShellLabels, ShellSettings, UpdatePhase } from "./api";
import type { SettingsEmit } from "./mockSettings";

type ShellApi = Pick<
  Api,
  | "shellSettings"
  | "shellSettingsPut"
  | "shellCloseRequested"
  | "shellQuit"
  | "shellQuitCancelled"
  | "shellLabelsSet"
  | "onMenuAction"
  | "helpOpen"
  | "trayAttention"
  | "windowReload"
  | "windowDevtoolsToggle"
  | "updateCheck"
  | "updatePhase"
  | "onUpdatePhase"
  | "updateDeferred"
  | "updateReleases"
  | "updateInstallTag"
>;

export type MockShell = ShellApi & {
  // Fires a native menu or tray item the way Rust does.
  __menu(action: MenuAction): void;
  // The mode of the quit in flight; null after a cancel or before any quit.
  __quitMode(): QuitMode | null;
  // How many times the tray dot was asked for.
  __attention(): number;
  // The help links opened, oldest first.
  __opened(): HelpLink[];
  // The labels the webview sent last, if any.
  __labels(): ShellLabels | null;
  // Reloads and developer tools toggles asked for.
  __windowCalls(): { reloads: number; devtools: number };
  // What the next close request answers; `close` unless told.
  __closeIntent(intent: CloseIntent): void;
};

/** `ShellSettings::default()` in Rust. */
export const SHELL_DEFAULTS: ShellSettings = {
  minimizeToTray: false,
  menuBarIcon: true,
  trayNoticeShown: false,
  updateChannel: "stable",
  updateDelayDays: 0,
  notchStatus: false,
};

/** What the mock build picker lists; the running mock version is newer than the last one. */
export const MOCK_BUILDS: ReleaseBuild[] = [
  { tag: "v0.4.0-rc.1", publishedAt: "2026-03-01T10:00:00Z", prerelease: true, older: false },
  { tag: "v0.3.1", publishedAt: "2026-02-20T08:30:00Z", prerelease: false, older: false },
  { tag: "v0.2.0", publishedAt: "2026-01-05T08:30:00Z", prerelease: false, older: true },
];

/**
 * The shell commands in memory. A check finds nothing unless `update` seeds a version; then it walks
 * checking, downloading, ready without timers, so a test sees every step in order.
 */
export function createMockShell(emit: SettingsEmit = () => {}, update: string | null = null): MockShell {
  let settings: ShellSettings = { ...SHELL_DEFAULTS };
  let phase: UpdatePhase = { kind: "idle" };
  let quit: QuitMode | null = null;
  let attention = 0;
  let labels: ShellLabels | null = null;
  let intent: CloseIntent = "close";
  const opened: HelpLink[] = [];
  const windowCalls = { reloads: 0, devtools: 0 };
  const menuListeners = new Set<(action: MenuAction) => void>();
  const phaseListeners = new Set<(p: UpdatePhase) => void>();

  const setPhase = (next: UpdatePhase) => {
    phase = next;
    for (const listener of [...phaseListeners]) listener(next);
  };

  return {
    async shellSettings() {
      return { ...settings };
    },
    async shellSettingsPut(next) {
      settings = { ...next, trayNoticeShown: settings.trayNoticeShown };
      emit(["shell"]);
      return { ...settings };
    },
    async shellCloseRequested(): Promise<CloseRequest> {
      return { intent, mode: quit };
    },
    async shellQuit(mode) {
      quit = mode;
    },
    async shellQuitCancelled() {
      quit = null;
    },
    async shellLabelsSet(next) {
      labels = { ...next };
    },
    async onMenuAction(cb) {
      menuListeners.add(cb);
      return () => void menuListeners.delete(cb);
    },
    async helpOpen(link) {
      opened.push(link);
    },
    async trayAttention() {
      attention += 1;
    },
    async windowReload() {
      windowCalls.reloads += 1;
    },
    async windowDevtoolsToggle() {
      windowCalls.devtools += 1;
    },
    async updateCheck(rc) {
      if (rc && settings.updateChannel !== "rc") {
        settings = { ...settings, updateChannel: "rc" };
        emit(["shell"]);
      }
      setPhase({ kind: "checking" });
      if (update === null) {
        setPhase({ kind: "up-to-date" });
      } else {
        setPhase({ kind: "downloading", version: update, percent: null });
        setPhase({ kind: "downloading", version: update, percent: 50 });
        setPhase({ kind: "ready", version: update, notes: null });
      }
      return phase;
    },
    async updatePhase() {
      return phase;
    },
    async updateDeferred() {
      return null;
    },
    async updateReleases() {
      return { kind: "loaded", builds: MOCK_BUILDS.filter((b) => !b.prerelease || settings.updateChannel === "rc") };
    },
    async updateInstallTag(tag) {
      const version = tag.replace(/^v/, "");
      setPhase({ kind: "checking" });
      setPhase({ kind: "downloading", version, percent: null });
      setPhase({ kind: "ready", version, notes: null });
      return phase;
    },
    async onUpdatePhase(cb) {
      phaseListeners.add(cb);
      return () => void phaseListeners.delete(cb);
    },
    __menu(action) {
      for (const listener of [...menuListeners]) listener(action);
    },
    __quitMode: () => quit,
    __attention: () => attention,
    __opened: () => [...opened],
    __labels: () => (labels === null ? null : { ...labels }),
    __windowCalls: () => ({ ...windowCalls }),
    __closeIntent(next) {
      intent = next;
    },
  };
}
