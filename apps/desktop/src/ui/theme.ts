import { applyTheme, resolveTheme, systemPrefersDark, watchSystemTheme, type MatchMediaLike, type ThemePreference } from "@xdev-asia/ui";
import type { Api } from "@/api";

// The app side of light / dark / system: the setting lives in `UiSettings.theme`; the helpers are xdev-ui's.

/** localStorage key of the last known preference, read before the first render. */
export const THEME_CACHE_KEY = "xdev.theme";

const PREFERENCES: readonly string[] = ["system", "dark", "light"];

type Root = Parameters<typeof applyTheme>[0];
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

function paint(): void {
  const e = theEnv();
  const dark = e.matchMedia ? systemPrefersDark(e.matchMedia) : true;
  applyTheme(e.root, resolveTheme(preference, dark));
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
 * Before the first render: applies the cached preference so the window does not flash. With no cache
 * the `data-theme="dark"` in index.html stays.
 */
export function applyCachedTheme(): void {
  const cached = readCachedTheme();
  if (cached) setThemePreference(cached);
}

/** Reads the stored preference and applies it; a failed read leaves what is shown. */
export async function loadTheme(api: Pick<Api, "uiSettingsGet">): Promise<void> {
  const s = await api.uiSettingsGet().catch(() => null);
  if (s) setThemePreference(s.theme);
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
