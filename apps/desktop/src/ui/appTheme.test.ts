import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_THEME_CACHE_KEY, applyCachedAppTheme, endPreview, paintAppTheme, previewAppTheme, refreshAppThemes, resetAppThemeForTests, selectAppTheme, setAppThemeSource } from "./appTheme";
import { OVERRIDE_STYLE_ID } from "./themeOverrides";
import { createMockAppThemes } from "../mockAppThemes";
import { fakeDocument, fakeStorage } from "./fakeDom";

let doc = fakeDocument();
let localStorage = fakeStorage();
const style = () => doc.getElementById(OVERRIDE_STYLE_ID);

function source() {
  const themes = createMockAppThemes();
  const terminalSettings = vi.fn(async () => ({ theme: "one", themeLight: "one" }) as never);
  const api = { ...themes, terminalSettings, terminalSettingsPut: vi.fn(async () => {}), terminalThemes: vi.fn(async () => []) };
  setAppThemeSource(api as never);
  return { themes, api };
}

beforeEach(() => {
  resetAppThemeForTests();
  doc = fakeDocument();
  localStorage = fakeStorage();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { localStorage });
});

describe("app theme", () => {
  it("paints a theme and caches its css; Default clears both", () => {
    paintAppTheme({ dark: { accent: "#abc" }, light: {} });
    expect(style()?.textContent).toContain("#aabbcc");
    expect(localStorage.getItem(APP_THEME_CACHE_KEY)).toContain("#aabbcc");
    paintAppTheme(null);
    expect(style()).toBeNull();
    expect(localStorage.getItem(APP_THEME_CACHE_KEY)).toBeNull();
  });

  it("inserts the cached css before the first render", () => {
    localStorage.setItem(APP_THEME_CACHE_KEY, "html { color: red }");
    applyCachedAppTheme();
    expect(style()?.textContent).toBe("html { color: red }");
  });

  it("selects a saved theme once the list is in, and falls back to Default for an unknown id", async () => {
    const { themes } = source();
    await themes.appThemeSave({ name: "Night", dark: { accent: "#abc" }, light: {} });
    selectAppTheme("night");
    await vi.waitFor(() => expect(style()?.textContent).toContain("#aabbcc"));
    selectAppTheme("gone");
    expect(style()).toBeNull();
  });

  it("applies the theme's terminal scheme", async () => {
    const { themes, api } = source();
    await themes.appThemeSave({ name: "Night", dark: {}, light: {}, terminalScheme: "dracula" });
    await refreshAppThemes();
    selectAppTheme("night");
    await vi.waitFor(() => expect(api.terminalSettingsPut).toHaveBeenCalled());
  });

  it("a preview does not touch the cache, and ending it repaints the active theme", () => {
    previewAppTheme({ dark: { accent: "#def" } });
    expect(style()?.textContent).toContain("#ddeeff");
    expect(localStorage.getItem(APP_THEME_CACHE_KEY)).toBeNull();
    endPreview();
    expect(style()).toBeNull();
  });
});
