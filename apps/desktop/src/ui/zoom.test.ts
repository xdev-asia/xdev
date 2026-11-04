import { beforeEach, expect, it, vi } from "vitest";
import type { UiSettings } from "@/api";
import { clampZoom, getZoom, loadZoom, resetZoomForTests, stepZoom } from "./zoom";

const style = { zoom: "" };
beforeEach(() => {
  resetZoomForTests();
  style.zoom = "";
  vi.stubGlobal("document", { documentElement: { style } });
});

it("clamps and rounds to one decimal", () => {
  expect(clampZoom(0.1)).toBe(0.5);
  expect(clampZoom(3)).toBe(2);
  expect(clampZoom(1.0000001 + 0.1)).toBe(1.1);
  expect(clampZoom(Number.NaN)).toBe(1);
});

it("steps, stores what the backend answers, and resets", async () => {
  let stored: UiSettings = { zoom: 1, restore: "agentsOnly" };
  const api = {
    uiSettingsGet: async () => stored,
    uiSettingsPut: vi.fn(async (s: UiSettings) => (stored = s)),
  };
  await stepZoom(api, 0.1);
  expect(style.zoom).toBe("1.1");
  // The restore mode goes back as stored.
  expect(api.uiSettingsPut).toHaveBeenLastCalledWith({ zoom: 1.1, restore: "agentsOnly" });
  await stepZoom(api, 0);
  expect(getZoom()).toBe(1);
  for (let i = 0; i < 30; i++) await stepZoom(api, 0.1);
  expect(getZoom()).toBe(2);
});

it("applies a step but stores nothing when the read fails", async () => {
  const put = vi.fn(async (s: UiSettings) => s);
  await stepZoom({ uiSettingsGet: async () => { throw new Error("x"); }, uiSettingsPut: put }, 0.1);
  expect(getZoom()).toBe(1.1);
  expect(put).not.toHaveBeenCalled();
});

it("loads the stored zoom, and ignores a failed read", async () => {
  await loadZoom({ uiSettingsGet: async () => ({ zoom: 1.3, restore: "all" }) });
  expect(style.zoom).toBe("1.3");
  await loadZoom({ uiSettingsGet: async () => { throw new Error("x"); } });
  expect(getZoom()).toBe(1.3);
});
