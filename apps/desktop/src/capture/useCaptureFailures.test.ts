import { beforeEach, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { createMockCapture } from "@/mockCapture";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { captureErrorKey, startCapture, useCaptureFailures } from "./useCaptureFailures";

const hooks = vi.hoisted(() => ({ effects: [] as (() => (() => void) | void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useEffect: (effect: () => (() => void) | void) => void hooks.effects.push(effect), useRef: <T,>(v: T) => ({ current: v }) };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

const t = (key: string) => translate("en", key);
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  hooks.effects = [];
  resetToastsForTests();
});

it("maps codes to their text and any other to the generic one", () => {
  expect(captureErrorKey("capture_no_tool")).toBe("capture.err.noTool");
  expect(captureErrorKey("capture_denied")).toBe("capture.perm.body");
  expect(captureErrorKey("io")).toBe("capture.err.failed");
});

it("a failed capture is a toast, and denied offers System Settings", async () => {
  const api = createMockCapture();
  useCaptureFailures(api);
  const stop = hooks.effects[0]();
  await tick();
  api.__captureFail("capture_no_tool");
  expect(getToasts().map((x) => x.text)).toEqual([t("capture.err.noTool")]);

  api.__captureFail("capture_denied");
  const [toast] = getToasts();
  expect(toast.text).toBe(t("capture.perm.body"));
  toast.actions[0].run();
  await tick();
  expect(api.__capturePrivacyOpens()).toBe(1);

  stop?.();
  resetToastsForTests();
  api.__captureFail("capture_timeout");
  expect(getToasts()).toEqual([]);
});

it("starting while a capture runs says so", async () => {
  const api = createMockCapture();
  startCapture(api, t);
  startCapture(api, t);
  await tick();
  expect(getToasts().map((x) => x.text)).toEqual([t("capture.err.busy")]);
  api.__captureCancel();
});
