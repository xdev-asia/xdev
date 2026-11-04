import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { TERMINAL_DEFAULTS } from "@/settings/terminalDefaults";
import { getCustomSchemes, loadCustomSchemes, resetCustomSchemesForTests, setCustomSchemes, startCustomSchemesSync, subscribeCustomSchemes } from "./customSchemes";
import { startSettingsSync } from "./terminalSettings";

beforeEach(resetCustomSchemesForTests);

const scheme = (id: string) => ({ id, name: id, mode: "dark" as const, colors: {} as never });

it("starts empty, and notifies a subscriber once per real change", () => {
  const heard = vi.fn();
  const off = subscribeCustomSchemes(heard);
  expect(getCustomSchemes()).toEqual([]);
  setCustomSchemes([scheme("custom-a")]);
  setCustomSchemes([scheme("custom-a")]);
  expect(heard).toHaveBeenCalledTimes(1);
  off();
  setCustomSchemes([]);
  expect(heard).toHaveBeenCalledTimes(1);
});

it("loads the stored list, and a failed load keeps the old one", async () => {
  const api = createMockApi({});
  setCustomSchemes([scheme("custom-old")]);
  vi.spyOn(api, "terminalThemes").mockRejectedValueOnce({ code: "io" });
  expect(await loadCustomSchemes(api)).toHaveLength(1);
  expect(await loadCustomSchemes(api)).toEqual([]);
});

it("reloads when settings://changed names terminal", async () => {
  const api = createMockApi({});
  const off = startSettingsSync(api);
  await vi.waitFor(() => expect(getCustomSchemes()).toEqual([]));
  const load = vi.spyOn(api, "terminalThemes");
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, scrollback: 500 });
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  off();
});

it("startCustomSchemesSync loads once now", async () => {
  const api = createMockApi({});
  const load = vi.spyOn(api, "terminalThemes");
  const off = startCustomSchemesSync(api);
  expect(load).toHaveBeenCalledTimes(1);
  off();
});
