import { afterEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { AUTOMATIONS_DEFAULTS } from "./generalDefaults";
import { getAutomationsSettings, loadAutomationsSettings, resetAutomationsSettingsForTests, setAutomationsSettings, startAutomationsSettingsSync, subscribeAutomationsSettings } from "./automationsSettings";

afterEach(resetAutomationsSettingsForTests);

it("starts from the defaults: the button shows and a delete asks", async () => {
  const api = createMockApi({});
  expect(getAutomationsSettings()).toEqual({ showButton: true, skipDeleteConfirm: false });
  await api.automationsSettingsPut({ showButton: false, skipDeleteConfirm: true });
  expect(await loadAutomationsSettings(api)).toEqual({ showButton: false, skipDeleteConfirm: true });
});

it("setAutomationsSettings tells readers once per real change", () => {
  const seen = vi.fn();
  const off = subscribeAutomationsSettings(seen);
  setAutomationsSettings({ ...AUTOMATIONS_DEFAULTS, showButton: false });
  setAutomationsSettings({ ...AUTOMATIONS_DEFAULTS, showButton: false });
  expect(seen).toHaveBeenCalledTimes(1);
  off();
});

it("a settings change that names automations reloads, another section does not", async () => {
  const api = createMockApi({});
  const stop = startAutomationsSettingsSync(api);
  await vi.waitFor(() => expect(getAutomationsSettings()).toEqual(AUTOMATIONS_DEFAULTS), { timeout: 5_000 });
  const read = vi.spyOn(api, "automationsSettings");
  await api.automationsSettingsPut({ showButton: false, skipDeleteConfirm: false });
  await vi.waitFor(() => expect(getAutomationsSettings().showButton).toBe(false), { timeout: 5_000 });
  expect(read).toHaveBeenCalledTimes(1);
  await api.navigationSettingsPut({ tabOrder: "sequential", confirmClosePinned: true, confirmCloseRunning: true, askBeforeDeleteWorktree: true, alwaysForceDeleteWorktrees: false, alwaysDeleteKeptBranches: false });
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});
