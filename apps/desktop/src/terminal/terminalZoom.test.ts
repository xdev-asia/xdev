import { beforeEach, expect, it, vi } from "vitest";
import type { TerminalSettings } from "@/api";
import { eventInTerminal, FONT_STEP, stepTerminalFont } from "./terminalZoom";
import { getTerminalSettings, resetTerminalSettingsForTests, setTerminalSettings, TERMINAL_DEFAULTS, TERMINAL_LIMITS } from "./terminalSettings";

const api = () => ({ terminalSettingsPut: vi.fn(async (s: TerminalSettings) => s) });

beforeEach(() => resetTerminalSettingsForTests());

it("an event inside an xterm element is a terminal event; others are not", () => {
  const inside = { target: { closest: (sel: string) => (sel === ".xterm" ? {} : null) } };
  expect(eventInTerminal(inside as unknown as KeyboardEvent)).toBe(true);
  expect(eventInTerminal({ target: { closest: () => null } } as unknown as KeyboardEvent)).toBe(false);
  expect(eventInTerminal({ target: null } as unknown as KeyboardEvent)).toBe(false);
  expect(eventInTerminal(undefined)).toBe(false);
});

it("steps the font size and stores it through the settings write path", async () => {
  const a = api();
  expect(await stepTerminalFont(a, FONT_STEP)).toBe(TERMINAL_DEFAULTS.fontSize + 1);
  expect(a.terminalSettingsPut).toHaveBeenCalledWith(expect.objectContaining({ fontSize: TERMINAL_DEFAULTS.fontSize + 1 }));
  expect(getTerminalSettings().fontSize).toBe(TERMINAL_DEFAULTS.fontSize + 1);
  expect(await stepTerminalFont(a, 0)).toBe(TERMINAL_DEFAULTS.fontSize);
});

it("stays inside the stored range and writes nothing at the edge", async () => {
  const a = api();
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: TERMINAL_LIMITS.fontSize.max });
  expect(await stepTerminalFont(a, FONT_STEP)).toBe(TERMINAL_LIMITS.fontSize.max);
  setTerminalSettings({ ...TERMINAL_DEFAULTS, fontSize: TERMINAL_LIMITS.fontSize.min });
  expect(await stepTerminalFont(a, -FONT_STEP)).toBe(TERMINAL_LIMITS.fontSize.min);
  expect(a.terminalSettingsPut).not.toHaveBeenCalled();
});

it("a failed write keeps the new size on screen", async () => {
  const a = { terminalSettingsPut: vi.fn(async () => Promise.reject(new Error("no"))) };
  expect(await stepTerminalFont(a, FONT_STEP)).toBe(TERMINAL_DEFAULTS.fontSize + 1);
});
