import { useSyncExternalStore } from "react";
import type { Api, EditorSettings } from "@/api";
import { EDITOR_DEFAULTS } from "./editorDefaults";

// One copy for the window: every open editor, autosave and the settings page read it.
let current: EditorSettings = EDITOR_DEFAULTS;
const listeners = new Set<() => void>();

export function getEditorSettings(): EditorSettings {
  return current;
}

/** Stores `next` and tells every reader, once per real change. */
export function setEditorSettings(next: EditorSettings): void {
  if ((Object.keys(EDITOR_DEFAULTS) as (keyof EditorSettings)[]).every((k) => current[k] === next[k])) return;
  current = { ...next };
  for (const l of [...listeners]) l();
}

export function subscribeEditorSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(subscribeEditorSettings, getEditorSettings, getEditorSettings);
}

/** Reads the stored settings; on failure the last known ones stay. */
export async function loadEditorSettings(api: Pick<Api, "editorSettings">): Promise<EditorSettings> {
  try {
    setEditorSettings(await api.editorSettings());
  } catch {
    // An editor is never blocked by a failed read.
  }
  return current;
}

/** Loads the settings and reloads them when `settings://changed` names the editor. Returns the stop. */
export function startEditorSettingsSync(api: Pick<Api, "editorSettings" | "onSettingsChanged">): () => void {
  void loadEditorSettings(api);
  return api.onSettingsChanged(({ sections }) => {
    if (sections.includes("editor")) void loadEditorSettings(api);
  });
}

/** Tests only. */
export function resetEditorSettingsForTests(): void {
  current = EDITOR_DEFAULTS;
  listeners.clear();
}
