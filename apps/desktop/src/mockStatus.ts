import type { Api, ApiError, HookDetail, HookEvent, PtyHook, StatusSettings } from "./api";
import type { SettingsEmit } from "./mockSettings";

type StatusApi = Pick<
  Api,
  | "onPtyHook"
  | "statusSettings"
  | "statusSettingsPut"
  | "statusNotify"
  | "onStatusNotificationClick"
  | "statusBadge"
  | "statusSoundSet"
  | "statusSound"
  | "pickSoundFile"
>;

export type MockStatus = StatusApi & {
  // Fires `pty://hook` the way an agent's hook would; `session` is the agent's own session id.
  __hook(id: string, event: HookEvent, detail?: HookDetail, session?: string): void;
  // Fires a click on the status notification of `ptyId`.
  __clickNotification(ptyId: string): void;
  // What the app sent to the OS, newest last.
  __notifications: { title: string; body: string; ptyId: string }[];
  __badge(): number;
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
  volume: 60,
  bell: true,
  badge: true,
};

const SOUND = /\.(wav|mp3|ogg)$/i;

/** Status channels in memory: hooks are fired by hand, the OS sees nothing. */
export function createMockStatus(emit: SettingsEmit = () => {}): MockStatus {
  let settings = { ...DEFAULT_STATUS };
  let badge = 0;
  const hooks = new Set<(hook: PtyHook) => void>();
  const clicks = new Set<(ptyId: string) => void>();
  const notifications: MockStatus["__notifications"] = [];

  return {
    async onPtyHook(cb) {
      hooks.add(cb);
      return () => hooks.delete(cb);
    },
    async statusSettings() {
      return { ...settings };
    },
    async statusSettingsPut(next) {
      settings = { ...next, soundFile: settings.soundFile, volume: Math.max(0, Math.min(100, Math.round(next.volume))) };
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
    async statusSoundSet(path) {
      if (path !== null && !SOUND.test(path)) {
        const error: ApiError = { code: "bad_sound" };
        return Promise.reject(error);
      }
      const ext = path?.match(SOUND)?.[1]?.toLowerCase();
      settings = { ...settings, soundFile: ext ? `/demo/data/sounds/custom.${ext}` : null };
      emit(["status"]);
      return { ...settings };
    },
    async statusSound() {
      return null;
    },
    async pickSoundFile() {
      return null;
    },
    __hook(id, event, detail, session) {
      for (const cb of hooks) cb({ id, event, at: Date.now(), detail: detail ?? null, session: session ?? null });
    },
    __clickNotification(ptyId) {
      for (const cb of clicks) cb(ptyId);
    },
    __notifications: notifications,
    __badge: () => badge,
  };
}
