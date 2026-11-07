import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLegacyNote, loadLegacyNote } from "./floatingNote";

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("legacy floating note", () => {
  it("reads and clears the phase 1 key", () => {
    vi.stubGlobal("localStorage", fakeStorage({ "xdev.floating.note.v1": "hello" }));
    expect(loadLegacyNote()).toBe("hello");
    clearLegacyNote();
    expect(loadLegacyNote()).toBe("");
  });

  it("survives a throwing store", () => {
    const boom = () => {
      throw new Error("no");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    expect(loadLegacyNote()).toBe("");
    expect(() => clearLegacyNote()).not.toThrow();
  });
});
