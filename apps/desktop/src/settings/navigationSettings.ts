import { useSyncExternalStore } from "react";
import type { Api, NavigationSettings } from "@/api";
import { NAVIGATION_DEFAULTS } from "./generalDefaults";

// One copy for the window: the tab strips and the worktree list read it, the General page writes it.
let current: NavigationSettings = NAVIGATION_DEFAULTS;
const listeners = new Set<() => void>();

export function getNavigationSettings(): NavigationSettings {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setNavigationSettings(next: NavigationSettings): void {
  if ((Object.keys(NAVIGATION_DEFAULTS) as (keyof NavigationSettings)[]).every((k) => current[k] === next[k])) return;
  current = { ...next };
  for (const l of [...listeners]) l();
}

export function subscribeNavigationSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useNavigationSettings(): NavigationSettings {
  return useSyncExternalStore(subscribeNavigationSettings, getNavigationSettings, getNavigationSettings);
}

/** Reads the stored settings; on failure the last known ones stay. */
export async function loadNavigationSettings(api: Pick<Api, "navigationSettings">): Promise<NavigationSettings> {
  try {
    setNavigationSettings(await api.navigationSettings());
  } catch {
    // Navigation is never blocked by a failed read.
  }
  return current;
}

/** Loads the settings and reloads them when `settings://changed` names navigation. Returns the stop. */
export function startNavigationSettingsSync(api: Pick<Api, "navigationSettings" | "onSettingsChanged">): () => void {
  void loadNavigationSettings(api);
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("navigation")) void loadNavigationSettings(api);
  });
}

/** Tests only. */
export function resetNavigationSettingsForTests(): void {
  current = NAVIGATION_DEFAULTS;
  listeners.clear();
}
