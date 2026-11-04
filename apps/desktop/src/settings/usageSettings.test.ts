import { afterEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { USAGE_DEFAULTS } from "./usageDefaults";
import { getUsageSettings, loadUsageSettings, resetUsageSettingsForTests, setUsageSettings, startUsageSync, subscribeUsageSettings } from "./usageSettings";

afterEach(resetUsageSettingsForTests);

it("starts from the defaults and loads what the backend stores", async () => {
  const api = createMockApi({});
  expect(getUsageSettings()).toEqual(USAGE_DEFAULTS);
  await api.usageSettingsPut({ ...USAGE_DEFAULTS, display: "remaining" });
  expect((await loadUsageSettings(api)).display).toBe("remaining");
});

it("setUsageSettings tells readers once per real change", () => {
  const seen = vi.fn();
  const off = subscribeUsageSettings(seen);
  setUsageSettings({ ...USAGE_DEFAULTS, display: "remaining" });
  setUsageSettings({ ...USAGE_DEFAULTS, display: "remaining" });
  expect(seen).toHaveBeenCalledTimes(1);
  expect(getUsageSettings().display).toBe("remaining");
  off();
});

it("a settings change that names usage reloads, another section does not", async () => {
  const api = createMockApi({});
  const stop = startUsageSync(api);
  await vi.waitFor(() => expect(getUsageSettings()).toEqual(USAGE_DEFAULTS), { timeout: 5_000 });
  const read = vi.spyOn(api, "usageSettings");
  await api.usageSettingsPut({ ...USAGE_DEFAULTS, display: "remaining" });
  await vi.waitFor(() => expect(getUsageSettings().display).toBe("remaining"), { timeout: 5_000 });
  expect(read).toHaveBeenCalledTimes(1);
  await api.navigationSettingsPut({ tabOrder: "sequential", confirmClosePinned: true, confirmCloseRunning: true, askBeforeDeleteWorktree: true });
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});
