import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { createMockSettings, createSettingsHub } from "@/mockSettings";
import { getStatusSettings, resetStatusSettings, STATUS_DEFAULTS } from "@/status/statusSettings";
import {
  getTerminalSettings,
  loadTerminalSettings,
  resetTerminalSettingsForTests,
  setTerminalSettings,
  startSettingsSync,
  subscribeTerminalSettings,
  TERMINAL_DEFAULTS,
} from "./terminalSettings";

beforeEach(() => {
  resetTerminalSettingsForTests();
  resetStatusSettings();
});

it("load then set notifies a subscriber once per real change", async () => {
  const api = createMockApi({});
  const heard = vi.fn();
  const off = subscribeTerminalSettings(heard);
  expect(getTerminalSettings()).toEqual(TERMINAL_DEFAULTS);
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, fontSize: 18 });
  expect((await loadTerminalSettings(api)).fontSize).toBe(18);
  expect(heard).toHaveBeenCalledTimes(1);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: 20 });
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: 20 });
  expect(heard).toHaveBeenCalledTimes(2);
  off();
  setTerminalSettings(TERMINAL_DEFAULTS);
  expect(heard).toHaveBeenCalledTimes(2);
});

it("a failed load keeps the old value", async () => {
  const api = createMockApi({});
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: 22 });
  vi.spyOn(api, "terminalSettings").mockRejectedValueOnce({ code: "io" });
  expect((await loadTerminalSettings(api)).fontSize).toBe(22);
  expect(getTerminalSettings().fontSize).toBe(22);
});

it("a settings change naming terminal reloads it, and status reloads status", async () => {
  const api = createMockApi({});
  const off = startSettingsSync(api);
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, scrollback: 500 });
  await vi.waitFor(() => expect(getTerminalSettings().scrollback).toBe(500));
  await api.statusSettingsPut({ ...STATUS_DEFAULTS, sound: false });
  await vi.waitFor(() => expect(getStatusSettings().sound).toBe(false));
  off();
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, scrollback: 900 });
  await Promise.resolve();
  expect(getTerminalSettings().scrollback).toBe(500);
});

it("the sync leaves a section alone when the event does not name it", async () => {
  const api = createMockApi({});
  const load = vi.spyOn(api, "terminalSettings");
  const off = startSettingsSync(api);
  await api.statusSettingsPut({ ...STATUS_DEFAULTS, bell: false });
  expect(load).not.toHaveBeenCalled();
  off();
});

it("the mock hub calls listeners synchronously with a copy and stops after unsubscribe", async () => {
  const hub = createSettingsHub();
  const api = createMockSettings(hub);
  const heard: string[][] = [];
  const off = api.onSettingsChanged((e) => heard.push(e.sections));
  hub.emit(["git" as never, "status"]);
  expect(heard).toEqual([["git", "status"]]);
  await api.terminalSettingsPut({ ...TERMINAL_DEFAULTS, fontSize: 200 });
  expect(heard[1]).toEqual(["terminal"]);
  expect((await api.terminalSettings()).fontSize).toBe(32);
  off();
  hub.emit(["terminal"]);
  expect(heard).toHaveLength(2);
});
