import { beforeEach, describe, expect, it } from "vitest";
import { calmWait, CALM_IDLE_MS, CALM_PANE_MS, claimInterruption, interruptionClaimed, mayClaim, resetInterruptionsForTests } from "./interruptions";

describe("the one-per-launch slot", () => {
  beforeEach(resetInterruptionsForTests);

  it("lets the first claim in and keeps the rest out", () => {
    expect(claimInterruption("tip")).toBe(true);
    expect(interruptionClaimed()).toBe(true);
    expect(claimInterruption("tour")).toBe(false);
    expect(claimInterruption("wall")).toBe(false);
  });
  it("ranks what's new over a tour over a tip while they wait", () => {
    expect(mayClaim("tip", null, ["tour"])).toBe(false);
    expect(mayClaim("tip", null, ["wall"])).toBe(false);
    expect(mayClaim("tour", null, ["wall"])).toBe(false);
    expect(mayClaim("tour", null, ["tip"])).toBe(true);
    expect(mayClaim("wall", null, ["tour", "tip"])).toBe(true);
  });
  it("lets a claim through the waiting list only when the slot is free", () => {
    expect(claimInterruption("tour", ["wall"])).toBe(false);
    expect(interruptionClaimed()).toBe(false);
    expect(claimInterruption("wall")).toBe(true);
    expect(mayClaim("wall", "wall", [])).toBe(false);
  });
});

describe("calm", () => {
  const now = 100_000;
  it("waits for two seconds without input", () => {
    expect(calmWait({ now, lastInput: now - 500, paneSince: null })).toBe(CALM_IDLE_MS - 500);
    expect(calmWait({ now, lastInput: now - CALM_IDLE_MS, paneSince: null })).toBe(0);
  });
  it("waits while the terminal is brand new", () => {
    expect(calmWait({ now, lastInput: 0, paneSince: now - 300 })).toBe(CALM_PANE_MS - 300);
    expect(calmWait({ now, lastInput: 0, paneSince: now - CALM_PANE_MS })).toBe(0);
  });
  it("waits for the longer of the two", () => {
    expect(calmWait({ now, lastInput: now - 1900, paneSince: now - 200 })).toBe(CALM_PANE_MS - 200);
  });
});
