import { describe, expect, it } from "vitest";
import { clampTerminalSettings, TERMINAL_DEFAULTS } from "./terminalDefaults";

describe("clampTerminalSettings, TUI scroll and running terminals", () => {
  const clamp = (tui: number, max: number) => {
    const s = clampTerminalSettings({ ...TERMINAL_DEFAULTS, tuiScrollSensitivity: tui, maxRunningTerminals: max });
    return [s.tuiScrollSensitivity, s.maxRunningTerminals];
  };

  it("rounds and clamps the TUI scroll speed", () => {
    expect(clamp(0.2, 10)[0]).toBe(1);
    expect(clamp(3.6, 10)[0]).toBe(4);
    expect(clamp(99, 10)[0]).toBe(10);
    expect(clamp(Number.NaN, 10)[0]).toBe(1);
  });

  it("rounds and clamps the running terminal cap", () => {
    expect(clamp(1, 0)[1]).toBe(1);
    expect(clamp(1, 5000)[1]).toBe(1024);
    expect(clamp(1, 300.4)[1]).toBe(300);
  });
});
