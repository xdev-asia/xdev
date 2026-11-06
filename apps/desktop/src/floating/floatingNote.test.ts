import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNote, saveNote } from "./floatingNote";

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

afterEach(() => vi.unstubAllGlobals());

describe("floatingNote", () => {
  it("saves and loads", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(loadNote()).toBe("");
    expect(saveNote("hello")).toBe(true);
    expect(loadNote()).toBe("hello");
  });

  it("survives a throwing store", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {
        throw new Error("no");
      },
    });
    expect(loadNote()).toBe("");
    expect(saveNote("x")).toBe(false);
  });

  it("does not write over 256 KiB", () => {
    const store = fakeStorage();
    const set = vi.spyOn(store, "setItem");
    vi.stubGlobal("localStorage", store);
    expect(saveNote("a".repeat(256 * 1024 + 1))).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(saveNote("a".repeat(256 * 1024))).toBe(true);
  });
});
