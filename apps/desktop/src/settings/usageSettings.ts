import { useSyncExternalStore } from "react";
import type { Api, UsageSettings } from "@/api";
import { USAGE_DEFAULTS } from "./usageDefaults";

// One copy for the window: the footer and the tab strips read it, the Stats & Usage page writes it.
let current: UsageSettings = USAGE_DEFAULTS;
const listeners = new Set<() => void>();

export function getUsageSettings(): UsageSettings {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setUsageSettings(next: UsageSettings): void {
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  current = structuredClone(next);
  for (const l of [...listeners]) l();
}

export function subscribeUsageSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useUsageSettings(): UsageSettings {
  return useSyncExternalStore(subscribeUsageSettings, getUsageSettings, getUsageSettings);
}

/** Reads the stored settings; on failure the last known ones stay. */
export async function loadUsageSettings(api: Pick<Api, "usageSettings">): Promise<UsageSettings> {
  try {
    setUsageSettings(await api.usageSettings());
  } catch {
    // The footer is never blocked by a failed read.
  }
  return current;
}

/** Loads the settings and reloads them when `settings://changed` names usage. Returns the stop. */
export function startUsageSync(api: Pick<Api, "usageSettings" | "onSettingsChanged">): () => void {
  void loadUsageSettings(api);
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("usage")) void loadUsageSettings(api);
  });
}

/** Tests only. */
export function resetUsageSettingsForTests(): void {
  current = USAGE_DEFAULTS;
  listeners.clear();
}
