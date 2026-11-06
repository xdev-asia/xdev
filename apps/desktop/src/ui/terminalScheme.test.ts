import { describe, expect, it } from "vitest";
import { planTerminalScheme, type SchemeMemory, type SchemePair } from "./terminalScheme";

const pair = (id: string, light = id): SchemePair => ({ theme: id, themeLight: light });

describe("planTerminalScheme", () => {
  it("sets the scheme and keeps the person's own pair", () => {
    const plan = planTerminalScheme(pair("one", "one-light"), null, "nord");
    expect(plan.set).toEqual(pair("nord"));
    expect(plan.memory).toEqual({ own: pair("one", "one-light"), applied: pair("nord") });
  });

  it("writes nothing when the terminal already has the scheme", () => {
    const plan = planTerminalScheme(pair("nord"), null, "nord");
    expect(plan.set).toBeNull();
    expect(plan.memory?.own).toEqual(pair("nord"));
  });

  it("moves from one theme's scheme to another without losing the own pair", () => {
    const memory: SchemeMemory = { own: pair("one"), applied: pair("nord") };
    const plan = planTerminalScheme(pair("nord"), memory, "dracula");
    expect(plan.set).toEqual(pair("dracula"));
    expect(plan.memory).toEqual({ own: pair("one"), applied: pair("dracula") });
  });

  it("keeps a scheme the person picked while a theme owned it", () => {
    const memory: SchemeMemory = { own: pair("one"), applied: pair("nord") };
    const plan = planTerminalScheme(pair("solar"), memory, "dracula");
    expect(plan.memory?.own).toEqual(pair("solar"));
  });

  it("restores the own pair when the next theme has no scheme", () => {
    const memory: SchemeMemory = { own: pair("one", "one-light"), applied: pair("nord") };
    const plan = planTerminalScheme(pair("nord"), memory, null);
    expect(plan.set).toEqual(pair("one", "one-light"));
    expect(plan.memory).toBeNull();
  });

  it("leaves the person's later choice alone", () => {
    const memory: SchemeMemory = { own: pair("one"), applied: pair("nord") };
    const plan = planTerminalScheme(pair("solar"), memory, null);
    expect(plan.set).toBeNull();
    expect(plan.memory).toBeNull();
  });

  it("does nothing without a scheme and without memory", () => {
    expect(planTerminalScheme(pair("one"), null, null)).toEqual({ set: null, memory: null });
  });
});
