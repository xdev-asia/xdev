import { describe, expect, it } from "vitest";
import type { DiffSettings } from "@/api";
import { DIFF_DEFAULTS } from "@/settings/generalDefaults";
import { clampListWidth, DEFAULT_VIEW, fromDiffSettings, LIST_DEFAULT, LOCAL_KEY, migrateViewOptions, readLocalView, readViewOptions, toDiffSettings, VIEW_KEY, writeLocalView, writeViewOptions } from "./viewOptions";

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

describe("diff settings", () => {
  const split: DiffSettings = { defaultView: "split", ignoreWhitespace: true, collapseUnchanged: false, wordWrap: true, fileTree: true };

  it("the default settings give the options the view always started with", () => {
    expect(fromDiffSettings(DIFF_DEFAULTS)).toEqual(DEFAULT_VIEW);
  });

  it("maps every setting to its option and back, fileTree included", () => {
    const opts = fromDiffSettings(split, { lineNumbers: false, listWidth: 300, attribution: false });
    expect(opts).toEqual({ layout: "split", ignoreWhitespace: true, collapse: false, wrap: true, tree: true, lineNumbers: false, listWidth: 300, attribution: false });
    expect(toDiffSettings(opts, split)).toEqual(split);
    expect(toDiffSettings({ ...opts, layout: "inline", wrap: false, tree: false }, split)).toEqual({ ...split, defaultView: "inline", wordWrap: false, fileTree: false });
  });

  it("the part a view keeps for itself round-trips and clamps", () => {
    const s = store();
    expect(readLocalView(s)).toEqual({ lineNumbers: true, listWidth: LIST_DEFAULT, attribution: true });
    writeLocalView(s, { lineNumbers: false, listWidth: 900, attribution: false });
    expect(readLocalView(s)).toEqual({ lineNumbers: false, listWidth: 480, attribution: false });
    expect(readLocalView(store("{nope"))).toEqual({ lineNumbers: true, listWidth: LIST_DEFAULT, attribution: true });
  });

  it("line authors are on by default, kept per view, and broken storage falls back to on", () => {
    expect(DEFAULT_VIEW.attribution).toBe(true);
    const local = (text: string) => ({ getItem: (k: string) => (k === LOCAL_KEY ? text : null) });
    expect(readLocalView(local("{}")).attribution).toBe(true);
    expect(readLocalView(local('{"attribution":false}')).attribution).toBe(false);
    expect(readLocalView(local('{"attribution":"no"}')).attribution).toBe(true);
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(readLocalView(throwing)).toEqual({ lineNumbers: true, listWidth: LIST_DEFAULT, attribution: true });
    const full = { setItem: () => { throw new Error("full"); } };
    expect(() => writeLocalView(full, { lineNumbers: true, listWidth: 240, attribution: false })).not.toThrow();
    const s = store();
    writeLocalView(s, { lineNumbers: true, listWidth: 240, attribution: false });
    expect(JSON.parse(s.getItem(LOCAL_KEY)!)).toMatchObject({ attribution: false });
  });
});

describe("migrating the old localStorage options", () => {
  const old = JSON.stringify({ ...DEFAULT_VIEW, layout: "split", wrap: true, lineNumbers: false, listWidth: 300 });
  function removable(initial?: string) {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(VIEW_KEY, initial);
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  }

  it("writes them while the settings are default, keeps the local part, and drops the key", async () => {
    const s = removable(old);
    const put = async (d: DiffSettings) => d;
    const now = await migrateViewOptions(s, DIFF_DEFAULTS, put);
    expect(now).toEqual({ ...DIFF_DEFAULTS, defaultView: "split", wordWrap: true });
    expect(s.data.has(VIEW_KEY)).toBe(false);
    expect(JSON.parse(s.data.get(LOCAL_KEY)!)).toEqual({ lineNumbers: false, listWidth: 300, attribution: true });
  });

  it("leaves settings the person already changed alone, and still drops the key", async () => {
    const s = removable(old);
    const chosen = { ...DIFF_DEFAULTS, ignoreWhitespace: true };
    const put = async () => { throw new Error("not called"); };
    expect(await migrateViewOptions(s, chosen, put)).toEqual(chosen);
    expect(s.data.has(VIEW_KEY)).toBe(false);
  });

  it("does nothing without the key, and keeps the key when the write fails", async () => {
    const none = removable();
    expect(await migrateViewOptions(none, DIFF_DEFAULTS, async (d) => d)).toEqual(DIFF_DEFAULTS);
    expect(none.data.size).toBe(0);
    const s = removable(old);
    expect(await migrateViewOptions(s, DIFF_DEFAULTS, async () => { throw new Error("disk"); })).toEqual(DIFF_DEFAULTS);
    expect(s.data.has(VIEW_KEY)).toBe(true);
  });
});
