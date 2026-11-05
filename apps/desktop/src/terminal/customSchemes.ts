import { useSyncExternalStore } from "react";
import type { Api, CustomScheme } from "@/api";

// One copy for the window: every terminal pane and the settings page read the imported schemes from here.
let current: readonly CustomScheme[] = [];
const listeners = new Set<() => void>();

/** The imported schemes as last loaded; empty until the first load. */
export function getCustomSchemes(): readonly CustomScheme[] {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setCustomSchemes(next: readonly CustomScheme[]): void {
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  current = [...next];
  for (const l of [...listeners]) l();
}

export function subscribeCustomSchemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useCustomSchemes(): readonly CustomScheme[] {
  return useSyncExternalStore(subscribeCustomSchemes, getCustomSchemes, getCustomSchemes);
}

/** Reads the stored list; on failure the last known one stays. */
export async function loadCustomSchemes(api: Pick<Api, "terminalThemes">): Promise<readonly CustomScheme[]> {
  try {
    setCustomSchemes(await api.terminalThemes());
  } catch {
    // A pane is never blocked by a failed read.
  }
  return current;
}

/** Loads the list now. Reloads on `settings://changed` come from `startSettingsSync` (section `terminal`). Returns the stop. */
export function startCustomSchemesSync(api: Pick<Api, "terminalThemes">): () => void {
  void loadCustomSchemes(api);
  return () => {};
}

/** Tests only. */
export function resetCustomSchemesForTests(): void {
  current = [];
  listeners.clear();
}
