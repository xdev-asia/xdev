import { beforeEach, expect, it, vi } from "vitest";
import type { UiSettings } from "@/api";
import { UI_SETTINGS_DEFAULTS } from "@/mockSettings";
import { currentEditorTheme } from "./editorTheme";
import { applyAppearance, applyCachedTheme, FONT_CACHE_KEY, getThemePreference, loadTheme, readCachedTheme, resetThemeForTests, setThemePreference, startThemeSync, THEME_CACHE_KEY } from "./theme";

function setup(opts: { dark?: boolean; store?: Record<string, string>; storageThrows?: boolean } = {}) {
  const attrs: Record<string, string> = { "data-theme": "dark" };
  const props: Record<string, string> = {};
  const store = opts.store ?? {};
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { dark: opts.dark ?? true };
  const env = {
    root: {
      setAttribute: (n: string, v: string) => void (attrs[n] = v),
      style: { setProperty: (n: string, v: string) => void (props[n] = v), removeProperty: (n: string) => delete props[n] },
    },
    matchMedia: () => ({
      get matches() {
        return state.dark;
      },
      addEventListener: (_t: "change", l: (e: { matches: boolean }) => void) => void listeners.add(l),
      removeEventListener: (_t: "change", l: (e: { matches: boolean }) => void) => void listeners.delete(l),
    }),
    storage: () => {
      if (opts.storageThrows) throw new Error("blocked");
      return { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) };
    },
  };
  resetThemeForTests(env);
  return { attrs, props, store, listeners, state, systemChanges: (dark: boolean) => { state.dark = dark; listeners.forEach((l) => l({ matches: dark })); } };
}

beforeEach(() => resetThemeForTests());

it("applies a fixed preference whatever the system says, and caches it", () => {
  const t = setup({ dark: true });
  setThemePreference("light");
  expect(t.attrs["data-theme"]).toBe("light");
  expect(t.store[THEME_CACHE_KEY]).toBe("light");
  expect(t.listeners.size).toBe(0);
});

it("follows the system while the preference is system, and stops when it is not", () => {
  const t = setup({ dark: true });
  setThemePreference("system");
  expect(t.attrs["data-theme"]).toBe("dark");
  t.systemChanges(false);
  expect(t.attrs["data-theme"]).toBe("light");
  setThemePreference("dark");
  expect(t.listeners.size).toBe(0);
  t.systemChanges(false);
  expect(t.attrs["data-theme"]).toBe("dark");
});

it("does not stack watchers when system is set twice", () => {
  const t = setup();
  setThemePreference("system");
  setThemePreference("system");
  expect(t.listeners.size).toBe(1);
});

it("paints the cached preference before the setting loads, resolving system against the system now", () => {
  const t = setup({ dark: false, store: { [THEME_CACHE_KEY]: "system" } });
  applyCachedTheme();
  expect(t.attrs["data-theme"]).toBe("light");
});

it("keeps index.html's dark when nothing is cached or the cache is bad", () => {
  const t = setup({ store: { [THEME_CACHE_KEY]: "sepia" } });
  applyCachedTheme();
  expect(t.attrs["data-theme"]).toBe("dark");
  expect(readCachedTheme()).toBeNull();
});

it("survives a storage that throws", () => {
  const t = setup({ storageThrows: true, dark: true });
  expect(readCachedTheme()).toBeNull();
  expect(() => setThemePreference("light")).not.toThrow();
  expect(t.attrs["data-theme"]).toBe("light");
});

it("reads an unknown stored value as system", () => {
  const t = setup({ dark: false });
  setThemePreference("sepia" as never);
  expect(getThemePreference()).toBe("system");
  expect(t.attrs["data-theme"]).toBe("light");
});

it("loadTheme applies the stored preference, and a failed read changes nothing", async () => {
  const t = setup();
  const ui: UiSettings = { ...UI_SETTINGS_DEFAULTS, theme: "light" };
  await loadTheme({ uiSettingsGet: async () => ui });
  expect(t.attrs["data-theme"]).toBe("light");
  await loadTheme({ uiSettingsGet: async () => Promise.reject(new Error("no")) });
  expect(t.attrs["data-theme"]).toBe("light");
});

it("startThemeSync reloads when settings://changed names ui, and only then", async () => {
  const t = setup();
  let stored: UiSettings = { ...UI_SETTINGS_DEFAULTS, theme: "light" };
  let emit: (sections: string[]) => void = () => {};
  const get = vi.fn(async () => stored);
  const off = vi.fn();
  startThemeSync({
    uiSettingsGet: get,
    onSettingsChanged: ((l: (e: { sections: string[] }) => void) => {
      emit = (sections) => l({ sections });
      return off;
    }) as never,
  });
  await vi.waitFor(() => expect(t.attrs["data-theme"]).toBe("light"), { timeout: 2000 });
  stored = { ...stored, theme: "dark" };
  emit(["terminal"]);
  expect(get).toHaveBeenCalledTimes(1);
  emit(["ui"]);
  await vi.waitFor(() => expect(t.attrs["data-theme"]).toBe("dark"), { timeout: 2000 });
});

it("applyAppearance paints theme, font and sidebar, and caches the font", () => {
  const t = setup();
  applyAppearance({ ...UI_SETTINGS_DEFAULTS, theme: "light", uiFont: "Inter", sidebar: "tinted" });
  expect(t.attrs["data-theme"]).toBe("light");
  expect(t.attrs["data-sidebar"]).toBe("tinted");
  expect(t.props["--font-body"]).toBe('"Inter", var(--x-font-body-fallback)');
  expect(t.store[FONT_CACHE_KEY]).toBe("Inter");
  applyAppearance({ ...UI_SETTINGS_DEFAULTS, theme: "light", uiFont: "", sidebar: "default" });
  expect(t.attrs["data-sidebar"]).toBe("default");
  expect(t.props["--font-body"]).toBeUndefined();
  expect(t.store[FONT_CACHE_KEY]).toBe("");
});

it("paints the cached font before the setting loads", () => {
  const t = setup({ store: { [FONT_CACHE_KEY]: "Inter" } });
  applyCachedTheme();
  expect(t.props["--font-body"]).toBe('"Inter", var(--x-font-body-fallback)');
});

it("a root without a style still takes the theme", () => {
  resetThemeForTests({ root: { setAttribute() {} }, matchMedia: undefined, storage: () => undefined });
  expect(() => applyAppearance({ ...UI_SETTINGS_DEFAULTS, theme: "dark", uiFont: "Inter", sidebar: "default" })).not.toThrow();
});

it("applyAppearance feeds the editor theme with the painted theme and the pick", () => {
  setup({ dark: true });
  applyAppearance({ ...UI_SETTINGS_DEFAULTS, theme: "dark", editorThemeDark: "light" });
  expect(currentEditorTheme()).toBe("light");
  applyAppearance({ ...UI_SETTINGS_DEFAULTS, theme: "light", editorThemeDark: "light" });
  expect(currentEditorTheme()).toBeUndefined();
});
