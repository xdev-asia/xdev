import type { Api, AppTheme } from "../api";
import { applyTokenOverrides, themeOverrideCss, OVERRIDE_STYLE_ID, type ThemeOverrides } from "./themeOverrides";
import { syncTerminalScheme } from "./terminalScheme";

// The active app theme: painted as a `<style>` of token overrides, its CSS cached in localStorage so
// the first frame has it, and its terminal scheme (if any) handed to the terminal settings.

/** localStorage key of the CSS of the active theme, read before the first render. */
export const APP_THEME_CACHE_KEY = "xdev.appThemeCss";

type ThemeApi = Pick<Api, "appThemes" | "terminalSettings" | "terminalSettingsPut" | "terminalThemes">;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storage = (): Store | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

function writeCache(css: string): void {
  try {
    if (css) storage()?.setItem(APP_THEME_CACHE_KEY, css);
    else storage()?.removeItem(APP_THEME_CACHE_KEY);
  } catch {
    // The cache is only a head start for the next start; the setting is the truth.
  }
}

/** Paints `theme` (null: the built-in colours) and caches its CSS; Default clears the cache. */
export function paintAppTheme(theme: Pick<AppTheme, "dark" | "light"> | null): void {
  if (typeof document === "undefined") return;
  const overrides: ThemeOverrides | null = theme && { dark: theme.dark, light: theme.light };
  applyTokenOverrides(document, overrides);
  writeCache(overrides ? themeOverrideCss(overrides) : "");
}

/** Before the first render: inserts the cached CSS. Nothing is cached for Default. */
export function applyCachedAppTheme(): void {
  if (typeof document === "undefined") return;
  let css: string | null | undefined;
  try {
    css = storage()?.getItem(APP_THEME_CACHE_KEY);
  } catch {
    css = null;
  }
  if (!css) return;
  const el = document.getElementById(OVERRIDE_STYLE_ID) ?? document.createElement("style");
  el.id = OVERRIDE_STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

let source: ThemeApi | null = null;
let list: AppTheme[] | null = null;
let loading: Promise<AppTheme[] | null> | null = null;
let wanted = "";
let previewing = false;

/** The api the list is read from; set by the theme sync. */
export function setAppThemeSource(api: ThemeApi): void {
  source = api;
}

/** The saved themes, once loaded. */
export function getAppThemes(): readonly AppTheme[] | null {
  return list;
}

const active = (): AppTheme | null => (wanted ? (list?.find((t) => t.id === wanted) ?? null) : null);

function paintActive(): void {
  if (previewing) return;
  const theme = active();
  paintAppTheme(theme);
  if (source && list) void syncTerminalScheme(source, theme?.terminalScheme ?? null);
}

function load(): Promise<AppTheme[] | null> {
  if (!source) return Promise.resolve(list);
  loading ??= source
    .appThemes()
    .then(
      (l) => {
        list = l;
        return l;
      },
      () => list,
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * The setting's theme id (empty: Default). Default paints at once; a saved theme waits for the list
 * (the cached CSS shows meanwhile) and falls back to Default when the id is not in it.
 */
export function selectAppTheme(id: string): void {
  wanted = id;
  if (id === "" || list) {
    paintActive();
    return;
  }
  void load().then(() => paintActive());
}

/** Reads the list again (after a save, import or remove) and paints the active theme. */
export async function refreshAppThemes(): Promise<readonly AppTheme[]> {
  list = null;
  await load();
  paintActive();
  return list ?? [];
}

/** Paints `o` without caching it: the editor's live view. */
export function previewAppTheme(o: ThemeOverrides): void {
  if (typeof document === "undefined") return;
  previewing = true;
  applyTokenOverrides(document, o);
}

/** Ends a preview: the active theme paints again. */
export function endPreview(): void {
  if (!previewing) return;
  previewing = false;
  paintActive();
}

/** Tests only. */
export function resetAppThemeForTests(): void {
  source = null;
  list = null;
  loading = null;
  wanted = "";
  previewing = false;
}
