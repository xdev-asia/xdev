import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureFailed, CaptureReady } from "./api";
import { CAPTURE_READY_MS, createMockCapture, MOCK_PASTE_DIR } from "./mockCapture";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function listen(api: ReturnType<typeof createMockCapture>) {
  const events: Array<["ready", CaptureReady] | ["failed", CaptureFailed]> = [];
  void api.onCaptureReady((e) => events.push(["ready", e]));
  void api.onCaptureFailed((e) => events.push(["failed", e]));
  return events;
}

describe("mock capture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits ready after the picker closes, and the path reads back as a 320×200 PNG", async () => {
    const api = createMockCapture();
    const events = listen(api);
    await api.captureStart();
    vi.advanceTimersByTime(CAPTURE_READY_MS - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(1);
    const [kind, ready] = events[0];
    expect(kind).toBe("ready");
    expect(ready).toMatchObject({ width: 320, height: 200 });
    const bytes = await api.captureRead((ready as CaptureReady).path);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_HEAD);
    expect(bytes.length).toBeLessThan(2048);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([320, 200]);
  });

  it("allows one capture at a time", async () => {
    const api = createMockCapture();
    await api.captureStart();
    await expect(api.captureStart()).rejects.toEqual({ code: "capture_busy" });
    vi.advanceTimersByTime(CAPTURE_READY_MS);
    await expect(api.captureStart()).resolves.toBeUndefined();
  });

  it("a failure emits failed instead of ready; a cancel emits nothing", async () => {
    const api = createMockCapture();
    const events = listen(api);
    await api.captureStart();
    api.__captureFail("capture_no_tool");
    vi.advanceTimersByTime(CAPTURE_READY_MS * 4);
    expect(events).toEqual([["failed", { code: "capture_no_tool", message: "" }]]);

    await api.captureStart();
    api.__captureCancel();
    vi.advanceTimersByTime(CAPTURE_READY_MS * 4);
    expect(events).toHaveLength(1);
    await expect(api.captureStart()).resolves.toBeUndefined();
  });

  it("the shortcut starts a capture only while it is on", async () => {
    const api = createMockCapture();
    const events = listen(api);
    api.__captureTrigger();
    vi.advanceTimersByTime(CAPTURE_READY_MS);
    expect(events.map(([k]) => k)).toEqual(["ready"]);

    await api.captureSettingsPut({ ...(await api.captureSettings()), enabled: false });
    api.__captureTrigger();
    vi.advanceTimersByTime(CAPTURE_READY_MS);
    expect(events).toHaveLength(1);
    expect(await api.captureShortcutApply()).toEqual({ status: "off" });
  });

  it("saves PNG bytes, refuses others, and reads only its own folder", async () => {
    const api = createMockCapture();
    expect(api.__captureSaved()).toBeNull();
    const png = Uint8Array.from([...PNG_HEAD, 1, 2, 3]);
    const path = await api.captureSavePng(png);
    expect(path.startsWith(`${MOCK_PASTE_DIR}/`)).toBe(true);
    expect(api.__captureSaved()).toEqual({ path, bytes: png });
    expect(await api.captureRead(path)).toEqual(png);
    await expect(api.captureSavePng(Uint8Array.from([1, 2, 3]))).rejects.toEqual({ code: "io" });
    await expect(api.captureRead("/etc/passwd")).rejects.toEqual({ code: "outside" });
  });

  it("the shortcut status and permission follow the mode", async () => {
    const plain = createMockCapture();
    expect(await plain.captureShortcutApply()).toEqual({ status: "registered", chord: "CmdOrCtrl+Alt+Shift+S" });
    expect(await plain.capturePermission()).toBe("granted");

    const wayland = createMockCapture({ mode: "wayland" });
    expect(await wayland.captureShortcutApply()).toEqual({ status: "unsupported", reason: "wayland" });
    const denied = createMockCapture({ mode: "denied" });
    expect(await denied.capturePermission()).toBe("denied");
    await denied.captureOpenPrivacy();
    expect(denied.__capturePrivacyOpens()).toBe(1);
  });

  it("keeps the settings in the store when one is given", async () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const first = createMockCapture({ store });
    await first.captureSettingsPut({ enabled: true, shortcut: "CmdOrCtrl+Shift+2", annotatePaste: true });
    const again = createMockCapture({ store });
    expect(await again.captureSettings()).toEqual({ enabled: true, shortcut: "CmdOrCtrl+Shift+2", annotatePaste: true });
  });
});
