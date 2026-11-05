import { useSyncExternalStore } from "react";
import type { Api, AutomationsSettings } from "@/api";
import { AUTOMATIONS_DEFAULTS } from "./generalDefaults";

// One copy for the window: the sidebar reads it, the Automations settings page writes it.
let current: AutomationsSettings = AUTOMATIONS_DEFAULTS;
const listeners = new Set<() => void>();

export function getAutomationsSettings(): AutomationsSettings {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setAutomationsSettings(next: AutomationsSettings): void {
  if ((Object.keys(AUTOMATIONS_DEFAULTS) as (keyof AutomationsSettings)[]).every((k) => current[k] === next[k])) return;
  current = { ...next };
  for (const l of [...listeners]) l();
}

export function subscribeAutomationsSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useAutomationsSettings(): AutomationsSettings {
  return useSyncExternalStore(subscribeAutomationsSettings, getAutomationsSettings, getAutomationsSettings);
}

/** Reads the stored settings; on failure the last known ones stay. */
export async function loadAutomationsSettings(api: Pick<Api, "automationsSettings">): Promise<AutomationsSettings> {
  try {
    setAutomationsSettings(await api.automationsSettings());
  } catch {
    // Automations are never blocked by a failed read.
  }
  return current;
}

/** Loads the settings and reloads them when `settings://changed` names automations. Returns the stop. */
export function startAutomationsSettingsSync(api: Pick<Api, "automationsSettings" | "onSettingsChanged">): () => void {
  void loadAutomationsSettings(api);
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("automations")) void loadAutomationsSettings(api);
  });
}

/** Tests only. */
export function resetAutomationsSettingsForTests(): void {
  current = AUTOMATIONS_DEFAULTS;
  listeners.clear();
}
