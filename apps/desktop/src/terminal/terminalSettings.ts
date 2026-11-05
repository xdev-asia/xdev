import { useSyncExternalStore } from "react";
import type { Api, TerminalSettings } from "@/api";
import { loadStatusSettings } from "@/status/statusSettings";
import { TERMINAL_DEFAULTS } from "@/settings/terminalDefaults";
import { loadCustomSchemes } from "./customSchemes";

// The defaults and the clamp live in `settings/terminalDefaults.ts` (a Rust test reads that file).
export { clampTerminalSettings, TERMINAL_DEFAULTS, TERMINAL_LIMITS } from "@/settings/terminalDefaults";

// One copy for the whole window: every terminal pane and the settings page read the same one.
let current: TerminalSettings = TERMINAL_DEFAULTS;
const listeners = new Set<() => void>();

/** The terminal settings as last loaded or set; the defaults until the first load. */
export function getTerminalSettings(): TerminalSettings {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setTerminalSettings(next: TerminalSettings): void {
  if (sameSettings(current, next)) return;
  current = { ...next };
  for (const l of [...listeners]) l();
}

/** Reads the stored settings from the desktop; on failure the last known ones stay. */
export async function loadTerminalSettings(api: Pick<Api, "terminalSettings">): Promise<TerminalSettings> {
  try {
    setTerminalSettings(await api.terminalSettings());
  } catch {
    // Keep what we had; a pane is never blocked by a failed read.
  }
  return current;
}

export function subscribeTerminalSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The terminal settings, re-rendering when they change. */
export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(subscribeTerminalSettings, getTerminalSettings, getTerminalSettings);
}

/**
 * Reloads a section's shared copy when `settings://changed` names it, so a write from this window or
 * another one shows everywhere. Call once at start; returns the unsubscribe.
 */
export function startSettingsSync(api: Pick<Api, "onSettingsChanged" | "terminalSettings" | "terminalThemes" | "statusSettings">): () => void {
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("terminal")) {
      void loadTerminalSettings(api);
      void loadCustomSchemes(api);
    }
    if (sections.includes("status")) void loadStatusSettings(api);
  });
}

/** Tests only. */
export function resetTerminalSettingsForTests(): void {
  current = TERMINAL_DEFAULTS;
  listeners.clear();
}

function sameSettings(a: TerminalSettings, b: TerminalSettings): boolean {
  return (Object.keys(TERMINAL_DEFAULTS) as (keyof TerminalSettings)[]).every((k) => a[k] === b[k]);
}
