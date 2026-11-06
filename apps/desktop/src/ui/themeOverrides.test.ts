import { describe, expect, it } from "vitest";
import { applyTokenOverrides, contrastIssues, contrastRatio, normalizeHex, overrideVars, themeOverrideCss, OVERRIDE_STYLE_ID, THEME_KEYS } from "./themeOverrides";
import { fakeDocument } from "./fakeDom";
import dusk from "../mockAppThemes.fixtures.json";

const DUSK = dusk["/home/demo/Dusk.xdev-theme.json"];

describe("normalizeHex", () => {
  it("expands #rgb and lower-cases", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#A1B2C3")).toBe("#a1b2c3");
  });
  it.each(["red", "#fff;}", "url(x)", "#ffff", ""])("rejects %s", (v) => expect(normalizeHex(v)).toBeNull());
});

describe("overrideVars", () => {
  it("sets every variable of a key and its derived tints", () => {
    const v = overrideVars({ accent: "#abc" });
    expect(v["--accent"]).toBe("#aabbcc");
    expect(v["--x-color-accent"]).toBe("#aabbcc");
    expect(v["--x-color-accent-soft"]).toBe("color-mix(in srgb, #aabbcc 18%, transparent)");
  });
  it("drops unknown keys and bad values", () => {
    expect(overrideVars({ nope: "#fff", accent: "red" })).toEqual({});
  });
  it("covers the Dusk fixture", () => {
    const v = overrideVars(DUSK.dark);
    expect(v["--bg-0"]).toBe("#14121f");
    expect(Object.keys(v).length).toBeGreaterThan(Object.keys(DUSK.dark).length);
  });
  it("has unique keys", () => {
    expect(new Set(THEME_KEYS.map((k) => k.key)).size).toBe(THEME_KEYS.length);
  });
});

describe("themeOverrideCss", () => {
  it("writes one rule per mode that has colours", () => {
    const css = themeOverrideCss({ dark: { accent: "#abc" } });
    expect(css).toContain('html[data-theme="dark"]');
    expect(css).not.toContain('"light"');
    expect(themeOverrideCss({})).toBe("");
  });
});

describe("applyTokenOverrides", () => {
  it("upserts and removes the style element", () => {
    const doc = fakeDocument();
    applyTokenOverrides(doc as never, { dark: { accent: "#abc" } });
    expect(doc.getElementById(OVERRIDE_STYLE_ID)?.textContent).toContain("#aabbcc");
    applyTokenOverrides(doc as never, { dark: { accent: "#def" } });
    expect(doc.count(OVERRIDE_STYLE_ID)).toBe(1);
    applyTokenOverrides(doc as never, null);
    expect(doc.getElementById(OVERRIDE_STYLE_ID)).toBeNull();
  });
});

describe("contrast", () => {
  it("matches the WCAG extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });
  it("lists failing pairs only", () => {
    const base = Object.fromEntries(THEME_KEYS.map((k) => [k.key, "#000000"])) as Record<string, string>;
    const good = { ...base, "text-1": "#ffffff", "text-2": "#ffffff", "text-3": "#ffffff", accent: "#ffffff", ok: "#ffffff", warn: "#ffffff", danger: "#ffffff" };
    expect(contrastIssues(good as never, { "on-accent": "#000000" })).toEqual([]);
    const bad = contrastIssues({ ...good, "text-1": "#111111" } as never, { "on-accent": "#000000" });
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((i) => i.fg === "text-1" && i.ratio < i.min)).toBe(true);
  });
});
