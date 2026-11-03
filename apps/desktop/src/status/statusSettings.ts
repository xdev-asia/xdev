import { useSyncExternalStore } from "react";
import type { Api, StatusSettings } from "@/api";

/** What the desktop stores before anyone changed a switch (`StatusSettings::default` in Rust). */
export const STATUS_DEFAULTS: StatusSettings = {
  enabled: true,
  onNeedsInput: true,
  onDone: true,
  onFailed: true,
  onBell: false,
  suppressWhenFocused: true,
  hooks: true,
  os: true,
  sound: true,
  soundFile: null,
  volume: 60,
  bell: true,
  badge: true,
};

// One copy for the whole window: the notifier, the bell and the settings page read the same one.
let current: StatusSettings = STATUS_DEFAULTS;
const listeners = new Set<() => void>();

/** The status settings as last loaded or set; the defaults until the first load. */
export function getStatusSettings(): StatusSettings {
  return current;
}

/** Stores `next` and tells every reader. The settings page calls it with what `statusSettingsPut` returned. */
export function setStatusSettings(next: StatusSettings): void {
  if (sameSettings(current, next)) return;
  current = { ...next };
  for (const l of [...listeners]) l();
}

/** Reads the stored settings from the desktop; on failure the last known ones stay. */
export async function loadStatusSettings(api: Pick<Api, "statusSettings">): Promise<StatusSettings> {
  try {
    setStatusSettings(await api.statusSettings());
  } catch {
    // Keep what we had; a channel is never blocked by a failed read.
  }
  return current;
}

export function subscribeStatusSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The status settings, re-rendering when they change. */
export function useStatusSettings(): StatusSettings {
  return useSyncExternalStore(subscribeStatusSettings, getStatusSettings, getStatusSettings);
}

/** Tests only. */
export function resetStatusSettings(): void {
  current = STATUS_DEFAULTS;
  listeners.clear();
}

function sameSettings(a: StatusSettings, b: StatusSettings): boolean {
  return (Object.keys(STATUS_DEFAULTS) as (keyof StatusSettings)[]).every((k) => a[k] === b[k]);
}
