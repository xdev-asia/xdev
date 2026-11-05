import { applyTheme, applyUiFont, resolveTheme, systemPrefersDark, watchSystemTheme, type FontRoot, type MatchMediaLike, type ThemePreference } from "@xdev-asia/ui";
import type { Api, UiSettings } from "@/api";
import { setEditorPrefs, setPaintedTheme } from "./editorTheme";
import { setTitlebar } from "./titlebar";
import { setHiddenApps } from "./hiddenApps";
import { sidebarTintValue } from "./sidebarTint";
import { setStatusBarItems } from "./statusBarItems";

// The app side of appearance: light / dark / system, the UI font and the sidebar look live in `UiSettings`; the helpers are xdev-ui's.

/** localStorage key of the last known preference, read before the first render. */
export const THEME_CACHE_KEY = "xdev.theme";

/** localStorage key of the last known UI font name, read before the first render. */
export const FONT_CACHE_KEY = "xdev.uiFont";

const PREFERENCES: readonly string[] = ["system", "dark", "light"];

type Root = Parameters<typeof applyTheme>[0] & Partial<FontRoot>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export type ThemeEnv = {
  root: Root;
  matchMedia: MatchMediaLike | undefined;
  storage: () => Storage | undefined;
};

function browserEnv(): ThemeEnv {
  return {
    root: document.documentElement,
    matchMedia: typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined,
    // The getter itself can throw (storage blocked), so it sits inside the try of every caller.
    storage: () => window.localStorage,
  };
}

let env: ThemeEnv | null = null;
let preference: ThemePreference = "system";
let unwatch: (() => void) | null = null;

const theEnv = (): ThemeEnv => (env ??= browserEnv());

/** The cached preference, or null when there is none or storage fails. */
export function readCachedTheme(): ThemePreference | null {
  try {
    const value = theEnv().storage()?.getItem(THEME_CACHE_KEY);
    return value && PREFERENCES.includes(value) ? (value as ThemePreference) : null;
  } catch {
    return null;
  }
}

function writeCache(pref: ThemePreference): void {
  try {
    theEnv().storage()?.setItem(THEME_CACHE_KEY, pref);
  } catch {
    // Storage is only a head start for the next start; the setting is the truth.
  }
}

/** The cached UI font name, or "" when there is none or storage fails. */
export function readCachedFont(): string {
  try {
    return theEnv().storage()?.getItem(FONT_CACHE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeFontCache(name: string): void {
  try {
    theEnv().storage()?.setItem(FONT_CACHE_KEY, name);
  } catch {
    // Storage is only a head start for the next start; the setting is the truth.
  }
}

function paintFont(name: string): void {
  const root = theEnv().root;
  if (root.style) applyUiFont({ style: root.style }, name);
}

function paint(): void {
  const e = theEnv();
  const dark = e.matchMedia ? systemPrefersDark(e.matchMedia) : true;
  const resolved = resolveTheme(preference, dark);
  applyTheme(e.root, resolved);
  setPaintedTheme(resolved);
}

/** The preference now in force. */
export function getThemePreference(): ThemePreference {
  return preference;
}

/**
 * Applies `pref`, caches it, and follows the system while it is `system`. The cache holds the
 * preference, not the painted value, so a start after the system changed still paints right.
 */
export function setThemePreference(pref: ThemePreference): void {
  preference = PREFERENCES.includes(pref) ? pref : "system";
  writeCache(preference);
  unwatch?.();
  unwatch = null;
  const e = theEnv();
  if (preference === "system" && e.matchMedia) unwatch = watchSystemTheme(e.matchMedia, paint);
  paint();
}

/**
 * Applies the appearance settings: the theme (and its system watch), the UI font, the sidebar
 * look (`data-sidebar` on the root, `--side-tint` for its wash), reduced effects (`data-effects`), the hidden apps, hands the editor pick to `useEditorTheme` and the footer items to `useStatusBarItems`. The font is cached so the next start paints it before the
 * first render.
 */
export function applyAppearance(
  ui: Pick<UiSettings, "theme" | "uiFont" | "sidebar" | "editorThemeLight" | "editorThemeDark"> & Partial<Pick<UiSettings, "statusBar" | "sidebarTint" | "sidebarTintOpacity" | "reduceEffects" | "hiddenApps" | "titlebar" | "showTitlebarName">>,
): void {
  setThemePreference(ui.theme);
  setEditorPrefs(ui);
  if (ui.statusBar) setStatusBarItems(ui.statusBar);
  paintFont(ui.uiFont);
  writeFontCache(ui.uiFont);
  const root = theEnv().root;
  root.setAttribute("data-sidebar", ui.sidebar === "tinted" ? "tinted" : "default");
  // The wash replaces the `--side-tint` token only while the sidebar is tinted and a tint is picked.
  const tint = ui.sidebar === "tinted" ? sidebarTintValue(ui.sidebarTint ?? "", ui.sidebarTintOpacity ?? Number.NaN) : null;
  if (root.style) {
    if (tint) root.style.setProperty("--side-tint", tint);
    else root.style.removeProperty("--side-tint");
  }
  root.setAttribute("data-effects", ui.reduceEffects ? "reduced" : "full");
  setHiddenApps(ui.hiddenApps ?? []);
  setTitlebar(ui);
}

/**
 * Before the first render: applies the cached preference and font so the window does not flash. With
 * no cache the `data-theme="dark"` in index.html and the default font stay.
 */
export function applyCachedTheme(): void {
  const cached = readCachedTheme();
  if (cached) setThemePreference(cached);
  const font = readCachedFont();
  if (font) paintFont(font);
}

/** Reads the stored appearance and applies it; a failed read leaves what is shown. */
export async function loadTheme(api: Pick<Api, "uiSettingsGet">): Promise<void> {
  const s = await api.uiSettingsGet().catch(() => null);
  if (s) applyAppearance(s);
}

/** Loads the setting, and again whenever `settings://changed` names `ui`. Returns the unsubscribe. */
export function startThemeSync(api: Pick<Api, "uiSettingsGet" | "onSettingsChanged">): () => void {
  void loadTheme(api);
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("ui")) void loadTheme(api);
  });
}

/** Tests only. */
export function resetThemeForTests(next: ThemeEnv | null = null): void {
  unwatch?.();
  unwatch = null;
  preference = "system";
  env = next;
}
