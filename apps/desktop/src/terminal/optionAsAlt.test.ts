import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MacOptionAsAlt } from "@/api";
import {
  classifyInputSource,
  effectiveOptionAsAlt,
  getDetectedLayout,
  resetDetectedLayoutForTests,
  startOptionAsAltProbe,
  subscribeDetectedLayout,
  type DetectedLayout,
} from "./optionAsAlt";

beforeEach(resetDetectedLayoutForTests);

describe("classifyInputSource", () => {
  it("knows the US and ABC layouts, any case", () => {
    expect(classifyInputSource("com.apple.keylayout.US")).toBe("us");
    expect(classifyInputSource("com.apple.keylayout.ABC")).toBe("us");
    expect(classifyInputSource("COM.APPLE.KEYLAYOUT.abc")).toBe("us");
  });
  it("treats other layouts as other and a missing id as unknown", () => {
    expect(classifyInputSource("com.apple.keylayout.German")).toBe("other");
    expect(classifyInputSource("com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese")).toBe("other");
    expect(classifyInputSource(null)).toBe("unknown");
    expect(classifyInputSource("")).toBe("unknown");
  });
});

describe("effectiveOptionAsAlt", () => {
  const settings: MacOptionAsAlt[] = ["auto", "both", "left", "right", "off"];
  const layouts: DetectedLayout[] = ["us", "other", "unknown"];
  it("resolves all 15 pairs", () => {
    for (const s of settings)
      for (const l of layouts) {
        const want = s === "auto" ? (l === "us" ? "both" : "off") : s;
        expect(effectiveOptionAsAlt(s, l)).toBe(want);
      }
  });
});

function fakeWindow() {
  const handlers = new Set<() => void>();
  return {
    handlers,
    win: {
      addEventListener: (_: string, cb: () => void) => void handlers.add(cb),
      removeEventListener: (_: string, cb: () => void) => void handlers.delete(cb),
    },
    focus: () => handlers.forEach((cb) => cb()),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startOptionAsAltProbe", () => {
  it("reads at start and on focus, and notifies only on change", async () => {
    const { win, focus } = fakeWindow();
    const read = vi.fn<() => Promise<string | null>>().mockResolvedValue("com.apple.keylayout.US");
    const changed = vi.fn();
    subscribeDetectedLayout(changed);
    startOptionAsAltProbe(read, win as never);
    await flush();
    expect(getDetectedLayout()).toBe("us");
    expect(changed).toHaveBeenCalledTimes(1);

    focus();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);

    read.mockResolvedValue("com.apple.keylayout.German");
    focus();
    await flush();
    expect(getDetectedLayout()).toBe("other");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("a failing read means unknown", async () => {
    const { win, focus } = fakeWindow();
    const read = vi.fn<() => Promise<string | null>>().mockResolvedValue("com.apple.keylayout.ABC");
    startOptionAsAltProbe(read, win as never);
    await flush();
    expect(getDetectedLayout()).toBe("us");
    read.mockRejectedValue(new Error("nope"));
    focus();
    await flush();
    expect(getDetectedLayout()).toBe("unknown");
  });

  it("the stop removes the listener and ignores a read still in flight", async () => {
    const { win, handlers } = fakeWindow();
    let resolve!: (id: string) => void;
    const read = () => new Promise<string | null>((r) => (resolve = r));
    const stop = startOptionAsAltProbe(read, win as never);
    expect(handlers.size).toBe(1);
    stop();
    expect(handlers.size).toBe(0);
    resolve("com.apple.keylayout.US");
    await flush();
    expect(getDetectedLayout()).toBe("unknown");
  });

  it("unsubscribing stops the notifications", async () => {
    const { win } = fakeWindow();
    const changed = vi.fn();
    const off = subscribeDetectedLayout(changed);
    off();
    startOptionAsAltProbe(() => Promise.resolve("com.apple.keylayout.US"), win as never);
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });
});
