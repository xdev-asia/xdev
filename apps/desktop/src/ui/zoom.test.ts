import { beforeEach, expect, it, vi } from "vitest";
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
  const put = vi.fn(async (s: { zoom: number }) => s);
  await stepZoom({ uiSettingsPut: put }, 0.1);
  expect(style.zoom).toBe("1.1");
  expect(put).toHaveBeenLastCalledWith({ zoom: 1.1 });
  await stepZoom({ uiSettingsPut: put }, 0);
  expect(getZoom()).toBe(1);
  for (let i = 0; i < 30; i++) await stepZoom({ uiSettingsPut: put }, 0.1);
  expect(getZoom()).toBe(2);
});

it("loads the stored zoom, and ignores a failed read", async () => {
  await loadZoom({ uiSettingsGet: async () => ({ zoom: 1.3 }) });
  expect(style.zoom).toBe("1.3");
  await loadZoom({ uiSettingsGet: async () => { throw new Error("x"); } });
  expect(getZoom()).toBe(1.3);
});
