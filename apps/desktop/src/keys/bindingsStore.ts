// The shortcuts that apply now: the registry's defaults with `keybindings.json` over them, and the
// key settings (terminal policy, hints). One copy for the whole window, like `status/statusSettings.ts`:
// the keymap, the terminal and the Shortcuts page read the same one.

import { useSyncExternalStore } from "react";
import type { Api, KeySettings } from "@/api";
import { PLATFORM } from "@/platform";
import { mergeBindings, parseKeybindings, type Diagnostic } from "./keybindingsFile";
import type { ActionId, EffectiveBinding } from "./keymap";

/** `KeySettings::default()` in Rust. */
export const KEY_SETTINGS_DEFAULTS: KeySettings = { terminalPolicy: "app-first", terminalHints: true };

export interface BindingsState {
  /** The file as last read; null when there is none. */
  text: string | null;
  /** Where the file lives; empty until the first read. */
  path: string;
  /** What the file asks for, after dropping what it got wrong. */
  overrides: Map<ActionId, string[]>;
  /** Every chord that applies on this platform. */
  bindings: EffectiveBinding[];
  /** What the file got wrong; empty for a missing or clean file. */
  diagnostics: Diagnostic[];
  keySettings: KeySettings;
}

function fromText(text: string | null, path: string, keySettings: KeySettings): BindingsState {
  const { overrides, diagnostics } = text === null ? { overrides: new Map<ActionId, string[]>(), diagnostics: [] } : parseKeybindings(text, PLATFORM);
  return { text, path, overrides, bindings: mergeBindings(overrides, PLATFORM), diagnostics, keySettings };
}

let current: BindingsState | null = null;
// Bumped by every new text, so a read that started before it does not put an older text back.
let generation = 0;
const listeners = new Set<() => void>();

/** The state as last loaded; the registry's defaults until the first load. */
export function getBindingsState(): BindingsState {
  current ??= fromText(null, "", KEY_SETTINGS_DEFAULTS);
  return current;
}

function publish(next: BindingsState): void {
  current = next;
  for (const l of [...listeners]) l();
}

/** Called after the bindings or the key settings change. Returns the unsubscribe. */
export function subscribeBindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Parses `text` (null: no file) and applies it. */
export function setKeybindingsText(text: string | null, path: string = getBindingsState().path): void {
  generation += 1;
  const now = getBindingsState();
  if (now.text === text && now.path === path) return;
  publish(fromText(text, path, now.keySettings));
}

export function setKeySettings(next: KeySettings): void {
  const now = getBindingsState();
  if (now.keySettings.terminalPolicy === next.terminalPolicy && now.keySettings.terminalHints === next.terminalHints) return;
  publish({ ...now, keySettings: { ...next } });
}

/** Reads the file from the desktop; on failure the last known bindings stay. */
export async function loadBindings(api: Pick<Api, "keybindingsRead">): Promise<BindingsState> {
  const started = generation;
  try {
    const { text, path } = await api.keybindingsRead();
    if (generation === started) setKeybindingsText(text, path);
  } catch {
    // Keep what we had; a broken read never takes the keys away.
  }
  return getBindingsState();
}

/** Reads the key settings; on failure the last known ones stay. */
export async function loadKeySettings(api: Pick<Api, "keySettingsGet">): Promise<KeySettings> {
  try {
    setKeySettings(await api.keySettingsGet());
  } catch {
    // Keep what we had.
  }
  return getBindingsState().keySettings;
}

type SyncApi = Pick<Api, "keybindingsRead" | "onKeybindingsChanged" | "keySettingsGet" | "onSettingsChanged">;

/**
 * Loads the file and the key settings, then follows `keybindings://changed` and the `keys` section of
 * `settings://changed`. Call once at start; returns the unsubscribe.
 */
export function startBindingsSync(api: SyncApi): () => void {
  let stopped = false;
  let stopFile: (() => void) | null = null;
  void api.onKeybindingsChanged((text) => setKeybindingsText(text)).then((stop) => {
    if (stopped) stop();
    else stopFile = stop;
  });
  const stopSettings = api.onSettingsChanged(({ sections }) => {
    if (sections.includes("keys")) void loadKeySettings(api);
  });
  void loadBindings(api);
  void loadKeySettings(api);
  return () => {
    stopped = true;
    stopFile?.();
    stopSettings();
  };
}

/** The bindings state, re-rendering when it changes. */
export function useBindings(): BindingsState {
  return useSyncExternalStore(subscribeBindings, getBindingsState, getBindingsState);
}

/** Tests only. */
export function resetBindingsForTests(): void {
  current = null;
  generation = 0;
  listeners.clear();
}
