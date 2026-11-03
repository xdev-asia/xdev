import { describe, expect, it } from "vitest";
import { clampListWidth, DEFAULT_VIEW, readViewOptions, VIEW_KEY, writeViewOptions } from "./viewOptions";

function store(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(VIEW_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("view options", () => {
  it("defaults when nothing is saved or the JSON is broken", () => {
    expect(readViewOptions(store())).toEqual(DEFAULT_VIEW);
    expect(readViewOptions(store("{nope"))).toEqual(DEFAULT_VIEW);
    expect(readViewOptions(store("[1]"))).toEqual(DEFAULT_VIEW);
    expect(readViewOptions(null)).toEqual(DEFAULT_VIEW);
  });

  it("defaults per value", () => {
    expect(readViewOptions(store(JSON.stringify({ layout: "wide", wrap: "yes", collapse: false, listWidth: "x" })))).toEqual({ ...DEFAULT_VIEW, collapse: false });
  });

  it("round-trips and clamps the width", () => {
    const s = store();
    writeViewOptions(s, { ...DEFAULT_VIEW, layout: "split", wrap: true, listWidth: 900 });
    expect(readViewOptions(s)).toEqual({ ...DEFAULT_VIEW, layout: "split", wrap: true, listWidth: 480 });
  });

  it("clampListWidth", () => {
    expect(clampListWidth(100)).toBe(160);
    expect(clampListWidth(300.4)).toBe(300);
    expect(clampListWidth(Number.NaN)).toBe(240);
  });
});
