import { useSyncExternalStore } from "react";
import type { Api, BrowserSettings } from "@/api";

export const BROWSER_DEFAULTS: BrowserSettings = { openLinksIn: "system", searchTemplate: "" };

// One copy for the window: the terminals read where links go, Settings → Browser writes it.
let current: BrowserSettings = BROWSER_DEFAULTS;
const listeners = new Set<() => void>();

export function getBrowserSettings(): BrowserSettings {
  return current;
}

export function setBrowserSettings(next: BrowserSettings): void {
  if (current.openLinksIn === next.openLinksIn && current.searchTemplate === next.searchTemplate) return;
  current = { openLinksIn: next.openLinksIn, searchTemplate: next.searchTemplate };
  for (const l of [...listeners]) l();
}

export function subscribeBrowserSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useBrowserSettings(): BrowserSettings {
  return useSyncExternalStore(subscribeBrowserSettings, getBrowserSettings, getBrowserSettings);
}

/** Reads the stored settings; on failure the last known ones stay. */
export async function loadBrowserSettings(api: Pick<Api, "browserSettings">): Promise<BrowserSettings> {
  try {
    setBrowserSettings(await api.browserSettings());
  } catch {
    // Links still open; the system browser is the default.
  }
  return current;
}

/** Loads the settings and reloads them when `settings://changed` names the browser. Returns the stop. */
export function startBrowserSettingsSync(api: Pick<Api, "browserSettings" | "onSettingsChanged">): () => void {
  void loadBrowserSettings(api);
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("browser")) void loadBrowserSettings(api);
  });
}

/** Tests only. */
export function resetBrowserSettingsForTests(): void {
  current = BROWSER_DEFAULTS;
  listeners.clear();
}
