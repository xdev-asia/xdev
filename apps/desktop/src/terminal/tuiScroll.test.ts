import { describe, expect, it } from "vitest";
import { createTuiWheelHandler, wheelReport, type MouseEncoding } from "./tuiScroll";

const none = { shift: false, alt: false, ctrl: false };

describe("wheelReport", () => {
  it("encodes SGR", () => {
    expect(wheelReport(true, 5, 7, none, "sgr")).toBe("\x1b[<64;5;7M");
    expect(wheelReport(false, 5, 7, { ...none, ctrl: true }, "sgr")).toBe("\x1b[<81;5;7M");
  });
  it("encodes urxvt", () => {
    expect(wheelReport(true, 5, 7, none, "urxvt")).toBe("\x1b[96;5;7M");
    expect(wheelReport(false, 5, 7, none, "urxvt")).toBe("\x1b[97;5;7M");
  });
  it("encodes the default form and drops positions past 223", () => {
    expect(wheelReport(true, 5, 7, none, "default")).toBe("\x1b[M" + String.fromCharCode(96, 37, 39));
    expect(wheelReport(false, 5, 7, { shift: true, alt: true, ctrl: false }, "default")).toBe(
      "\x1b[M" + String.fromCharCode(32 + 77, 37, 39),
    );
    expect(wheelReport(true, 224, 7, none, "default")).toBe("");
  });
});

function setup(over: { speed?: number; mode?: string; enc?: MouseEncoding } = {}) {
  const sent: string[] = [];
  const handler = createTuiWheelHandler({
    speed: () => over.speed ?? 1,
    trackingMode: () => over.mode ?? "any",
    encoding: () => over.enc ?? "sgr",
    cell: () => ({ col: 2, row: 3, height: 10 }),
    send: (d) => sent.push(d),
  });
  const wheel = (deltaY: number, deltaMode = 1) =>
    handler({ deltaY, deltaMode, shiftKey: false, altKey: false, ctrlKey: false } as WheelEvent);
  return { sent, wheel };
}

describe("createTuiWheelHandler", () => {
  it("leaves speed 1 and untracked mice to xterm", () => {
    const a = setup({ speed: 1 });
    expect(a.wheel(-1)).toBe(true);
    const b = setup({ speed: 3, mode: "none" });
    expect(b.wheel(-1)).toBe(true);
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
  });
  it("repeats one line step by the speed", () => {
    const { sent, wheel } = setup({ speed: 3 });
    expect(wheel(-1)).toBe(false);
    expect(sent).toEqual(["\x1b[<64;2;3M".repeat(3)]);
  });
  it("counts pixel deltas by cell height", () => {
    const { sent, wheel } = setup({ speed: 2 });
    expect(wheel(20, 0)).toBe(false);
    expect(sent).toEqual(["\x1b[<65;2;3M".repeat(4)]);
  });
  it("caps one event at 100 reports", () => {
    const { sent, wheel } = setup({ speed: 10 });
    wheel(50);
    expect(sent[0]!.split("M").length - 1).toBe(100);
  });
});
