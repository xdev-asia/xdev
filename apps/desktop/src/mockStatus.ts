import type { Api, ApiError, Cli, CliHooks, HookDetail, HookEvent, NotificationPermission, PtyHook, StatusSettings } from "./api";
import type { SettingsEmit } from "./mockSettings";

type StatusApi = Pick<
  Api,
  | "onPtyHook"
  | "statusSettings"
  | "statusSettingsPut"
  | "statusNotify"
  | "onStatusNotificationClick"
  | "statusBadge"
  | "statusDismiss"
  | "statusPermission"
  | "statusOpenSettings"
  | "statusSoundSet"
  | "statusSound"
  | "pickSoundFile"
  | "hookInstalls"
  | "hookInstall"
  | "hookUninstall"
>;

export type MockStatus = StatusApi & {
  // Fires `pty://hook` the way an agent's hook would; `session` is the agent's own session id.
  __hook(id: string, event: HookEvent, detail?: HookDetail, session?: string): void;
  // Fires a click on the status notification of `ptyId`.
  __clickNotification(ptyId: string): void;
  // What the app sent to the OS, newest last.
  __notifications: { title: string; body: string; ptyId: string }[];
  __badge(): number;
  // The pane ids `statusDismiss` was called for, in order.
  __dismissed: string[];
  // What `statusPermission` answers next (default "unknown").
  __setPermission(state: NotificationPermission): void;
  // How many times `statusOpenSettings` was called.
  __openedSettings(): number;
};

export const DEFAULT_STATUS: StatusSettings = {
  enabled: true,
  onNeedsInput: true,
  onDone: true,
  onFailed: true,
  onBell: false,
  suppressWhenFocused: true,
  hooks: true,
  os: true,
  sound: true,
  soundFile: null,
  soundName: "two-tone",
  volume: 60,
  bell: true,
  badge: true,
};

const SOUND = /\.(wav|mp3|ogg)$/i;

/** Where the demo's managed CLIs keep xDev's hooks, as on macOS. */
const HOOK_FILES: Partial<Record<Cli, string>> = {
  gemini: "/home/me/.gemini/settings.json",
  copilot: "/home/me/.copilot/hooks/xdev-status.json",
  opencode: "/home/me/.config/opencode/plugin/xdev-status.js",
  kilo: "/home/me/.config/kilo/plugin/xdev-status.js",
  antigravity: "/home/me/.gemini/config/hooks.json",
};

const HOOK_CLIS: readonly Cli[] = ["claude", "codex", "gemini", "cursor", "copilot", "opencode", "amp", "droid", "qwen-code", "kimi", "devin", "aider", "goose", "grok", "kiro", "kilo", "cline", "antigravity", "pi", "command-code"];

/** Every catalogue CLI as the backend reads it on a machine where nothing is installed yet. */
function hookRows(): CliHooks[] {
  return HOOK_CLIS.map((cli) => {
    const settings = HOOK_FILES[cli] ?? null;
    if (cli === "claude" || cli === "codex") return { cli, support: { kind: "launch" }, state: null, settings: null, error: null };
    if (settings) return { cli, support: { kind: "managed" }, state: "missing", settings, error: null };
    return { cli, support: { kind: "unsupported", reason: "not-checked" }, state: null, settings: null, error: null };
  });
}

/** Status channels in memory: hooks are fired by hand, the OS sees nothing. */
export function createMockStatus(emit: SettingsEmit = () => {}): MockStatus {
  let settings = { ...DEFAULT_STATUS };
  let badge = 0;
  const hooks = new Set<(hook: PtyHook) => void>();
  const clicks = new Set<(ptyId: string) => void>();
  const notifications: MockStatus["__notifications"] = [];
  const dismissed: string[] = [];
  let permission: NotificationPermission = "unknown";
  let opened = 0;
  let hookInstalls = hookRows();
  const hookRow = (cli: Cli, state: "installed" | "missing"): CliHooks => {
    const row = hookInstalls.find((r) => r.cli === cli);
    if (!row || row.support.kind !== "managed") throw { code: "hooks-unsupported" } satisfies ApiError;
    const next = { ...row, state };
    hookInstalls = hookInstalls.map((r) => (r.cli === cli ? next : r));
    return next;
  };

  return {
    async onPtyHook(cb) {
      hooks.add(cb);
      return () => hooks.delete(cb);
    },
    async statusSettings() {
      return { ...settings };
    },
    async statusSettingsPut(next) {
      const soundName = next.soundName === "file" && settings.soundFile === null ? "two-tone" : next.soundName;
      settings = { ...next, soundName, soundFile: settings.soundFile, volume: Math.max(0, Math.min(100, Math.round(next.volume))) };
      emit(["status"]);
      return { ...settings };
    },
    async statusNotify(title, body, ptyId) {
      notifications.push({ title, body, ptyId });
    },
    async onStatusNotificationClick(cb) {
      clicks.add(cb);
      return () => clicks.delete(cb);
    },
    async statusBadge(count) {
      badge = count;
    },
    async statusDismiss(ptyId) {
      dismissed.push(ptyId);
    },
    async statusPermission() {
      return permission;
    },
    async statusOpenSettings() {
      opened += 1;
    },
    async statusSoundSet(path) {
      if (path !== null && !SOUND.test(path)) {
        const error: ApiError = { code: "bad_sound" };
        return Promise.reject(error);
      }
      const ext = path?.match(SOUND)?.[1]?.toLowerCase();
      settings = { ...settings, soundFile: ext ? `/demo/data/sounds/custom.${ext}` : null, soundName: ext ? "file" : "two-tone" };
      emit(["status"]);
      return { ...settings };
    },
    async statusSound() {
      return null;
    },
    async pickSoundFile() {
      return null;
    },
    async hookInstalls() {
      return hookInstalls.map((r) => ({ ...r }));
    },
    async hookInstall(cli) {
      return hookRow(cli, "installed");
    },
    async hookUninstall(cli) {
      return hookRow(cli, "missing");
    },
    __hook(id, event, detail, session) {
      for (const cb of hooks) cb({ id, event, at: Date.now(), detail: detail ?? null, session: session ?? null });
    },
    __clickNotification(ptyId) {
      for (const cb of clicks) cb(ptyId);
    },
    __notifications: notifications,
    __badge: () => badge,
    __dismissed: dismissed,
    __setPermission(state) {
      permission = state;
    },
    __openedSettings: () => opened,
  };
}
