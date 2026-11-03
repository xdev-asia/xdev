import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { STATUS_DEFAULTS, getStatusSettings, loadStatusSettings, resetStatusSettings, setStatusSettings, subscribeStatusSettings } from "./statusSettings";

beforeEach(() => resetStatusSettings());

it("set tells readers, once per real change", () => {
  const heard = vi.fn();
  const off = subscribeStatusSettings(heard);
  expect(getStatusSettings()).toEqual(STATUS_DEFAULTS);
  setStatusSettings({ ...STATUS_DEFAULTS, bell: false });
  expect(getStatusSettings().bell).toBe(false);
  setStatusSettings({ ...STATUS_DEFAULTS, bell: false });
  expect(heard).toHaveBeenCalledTimes(1);
  off();
  setStatusSettings(STATUS_DEFAULTS);
  expect(heard).toHaveBeenCalledTimes(1);
});

it("load reads the stored settings and keeps the last on failure", async () => {
  const api = createMockApi({});
  await api.statusSettingsPut({ ...STATUS_DEFAULTS, sound: false });
  expect((await loadStatusSettings(api)).sound).toBe(false);
  vi.spyOn(api, "statusSettings").mockRejectedValueOnce({ code: "io" });
  expect((await loadStatusSettings(api)).sound).toBe(false);
  expect(getStatusSettings().sound).toBe(false);
});
