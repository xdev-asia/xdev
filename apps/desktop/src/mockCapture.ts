import type { Api, ApiError, CaptureFailed, CapturePermission, CaptureReady, CaptureSettings, ErrorCode, ShortcutStatus } from "./api";

type CaptureApi = Pick<
  Api,
  | "captureStart"
  | "captureSavePng"
  | "captureRead"
  | "capturePermission"
  | "captureOpenPrivacy"
  | "captureShortcutApply"
  | "captureSettings"
  | "captureSettingsPut"
  | "onCaptureReady"
  | "onCaptureFailed"
>;

export type MockCapture = CaptureApi & {
  /** The capture running now fails with `code`: emits `capture://failed`. */
  __captureFail(code: ErrorCode): void;
  /** The person backs out of the capture running now: no event. */
  __captureCancel(): void;
  /** The last PNG `captureSavePng` stored, or null. */
  __captureSaved(): { path: string; bytes: Uint8Array } | null;
  /** Acts as the global shortcut: starts a capture when the shortcut is on. */
  __captureTrigger(): void;
  /** How many times `captureOpenPrivacy` ran. */
  __capturePrivacyOpens(): number;
};

export type MockCaptureOptions = {
  /** `?capture=denied`: Screen Recording is off. `?capture=wayland`: no global shortcuts. */
  mode?: "denied" | "wayland" | null;
  /** With a store the settings outlive a page reload (the e2e `?capturekeep` flag). */
  store?: Pick<Storage, "getItem" | "setItem">;
};

/** How long the fake region picker stays open before `capture://ready`. */
export const CAPTURE_READY_MS = 50;
export const MOCK_CAPTURE_SIZE = { width: 320, height: 200 } as const;
/** `paste_dir` in the demo. */
export const MOCK_PASTE_DIR = "/demo/paste";
/** A 320×200 PNG of one flat colour. */
const DEMO_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAABvUlEQVR42u3TQQkAAAgEwetlO0P7NoQvYWASLGyqB3gqEoCBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgOrAAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDAZWAQwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDFwuxSObZtDf59wAAAABJRU5ErkJggg==";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** `PASTE_MAX_BYTES` in `clipboard.rs`. */
const MAX_BYTES = 18 * 1024 * 1024;
const STORE_KEY = "xdev.mock.capture";

const DEFAULTS: CaptureSettings = { enabled: true, shortcut: "CmdOrCtrl+Alt+Shift+S", annotatePaste: false };

function reject(code: ErrorCode): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

function demoPng(): Uint8Array {
  return Uint8Array.from(atob(DEMO_PNG), (c) => c.charCodeAt(0));
}

/** `?capture=denied` and `?capture=wayland` preview the banners; `?capturekeep` keeps the settings over a reload. */
export function captureOptionsFromLocation(): MockCaptureOptions {
  if (typeof location === "undefined") return {};
  const params = new URLSearchParams(location.search);
  const mode = params.get("capture");
  return {
    mode: mode === "denied" || mode === "wayland" ? mode : null,
    store: params.has("capturekeep") ? sessionStorage : undefined,
  };
}

/** The capture commands in memory: one capture at a time, files in a fake paste folder. */
export function createMockCapture(options: MockCaptureOptions = {}): MockCapture {
  const { mode = null, store } = options;
  const kept = store?.getItem(STORE_KEY);
  let settings: CaptureSettings = kept ? { ...DEFAULTS, ...(JSON.parse(kept) as Partial<CaptureSettings>) } : { ...DEFAULTS };
  const files = new Map<string, Uint8Array>();
  const ready = new Set<(e: CaptureReady) => void>();
  const failed = new Set<(e: CaptureFailed) => void>();
  let running: ReturnType<typeof setTimeout> | null = null;
  let next = 1;
  let saved: { path: string; bytes: Uint8Array } | null = null;
  let privacyOpens = 0;

  const on = <T>(set: Set<(e: T) => void>, cb: (e: T) => void): Promise<() => void> => {
    set.add(cb);
    return Promise.resolve(() => void set.delete(cb));
  };
  const newPath = () => `${MOCK_PASTE_DIR}/xdev-paste-${next++}.png`;
  const stop = () => {
    if (running !== null) clearTimeout(running);
    running = null;
  };
  const start = () => {
    if (running !== null) return false;
    running = setTimeout(() => {
      running = null;
      const path = newPath();
      files.set(path, demoPng());
      const e: CaptureReady = { path, ...MOCK_CAPTURE_SIZE };
      for (const cb of ready) cb({ ...e });
    }, CAPTURE_READY_MS);
    return true;
  };

  return {
    async captureStart() {
      if (!start()) return reject("capture_busy");
    },
    async captureSavePng(bytes) {
      if (bytes.length > MAX_BYTES) return reject("too_large");
      if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return reject("io");
      const path = newPath();
      files.set(path, bytes.slice());
      saved = { path, bytes: bytes.slice() };
      return path;
    },
    async captureRead(path) {
      const bytes = files.get(path);
      return bytes ? bytes.slice() : reject(path.startsWith(`${MOCK_PASTE_DIR}/`) ? "not_found" : "outside");
    },
    async capturePermission(): Promise<CapturePermission> {
      return mode === "denied" ? "denied" : "granted";
    },
    async captureOpenPrivacy() {
      privacyOpens += 1;
    },
    async captureShortcutApply(): Promise<ShortcutStatus> {
      if (!settings.enabled || !settings.shortcut.trim()) return { status: "off" };
      if (mode === "wayland") return { status: "unsupported", reason: "wayland" };
      return { status: "registered", chord: settings.shortcut.trim() };
    },
    async captureSettings() {
      return { ...settings };
    },
    async captureSettingsPut(v) {
      settings = { ...v };
      store?.setItem(STORE_KEY, JSON.stringify(settings));
      return { ...settings };
    },
    onCaptureReady: (cb) => on(ready, cb),
    onCaptureFailed: (cb) => on(failed, cb),
    __captureFail(code) {
      stop();
      const e: CaptureFailed = { code, message: "" };
      for (const cb of failed) cb({ ...e });
    },
    __captureCancel() {
      stop();
    },
    __captureSaved() {
      return saved && { path: saved.path, bytes: saved.bytes.slice() };
    },
    __captureTrigger() {
      if (settings.enabled && mode !== "wayland") start();
    },
    __capturePrivacyOpens() {
      return privacyOpens;
    },
  };
}
