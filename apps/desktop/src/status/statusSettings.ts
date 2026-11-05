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
  soundName: "two-tone",
  volume: 60,
  bell: true,
  badge: true,
};

/** What can ask for the person: a state of the agent, or a terminal bell. */
export type StatusEventKind = "needs-you" | "done" | "failed" | "bell";

/** Whether the master switch and the switch of this event are both on. Every channel asks it first. */
export function eventOn(settings: StatusSettings, event: StatusEventKind): boolean {
  if (!settings.enabled) return false;
  switch (event) {
    case "needs-you":
      return settings.onNeedsInput;
    case "done":
      return settings.onDone;
    case "failed":
      return settings.onFailed;
    case "bell":
      return settings.onBell;
  }
}

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

/**
 * Writes `patch` over the settings stored now, not over a copy read earlier: the other settings page
 * and `xdev agent hooks on|off` write the same file. Returns what was stored.
 */
export async function patchStatusSettings(
  api: Pick<Api, "statusSettings" | "statusSettingsPut">,
  patch: Partial<StatusSettings>,
): Promise<StatusSettings> {
  const fresh = await api.statusSettings();
  return api.statusSettingsPut({ ...fresh, ...patch });
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
