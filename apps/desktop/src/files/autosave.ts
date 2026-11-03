import type { Api } from "@/api";
import { getEditorSettings, subscribeEditorSettings } from "./editorSettings";
import { type FileIo, saveFile } from "./fileIO";
import { type FileTabs, isDirty } from "./fileTabs";

/**
 * Saves a dirty file `autosaveMs` after its last edit, when `editor.autosave` is on. A file with a
 * conflict is never saved this way: the person chooses Overwrite or Reload. Returns the stop.
 */
export function startAutosave(api: Api, store: FileTabs, t: FileIo["t"]): () => void {
  // The text each pending timer waits to save; an edit replaces the timer, so it is a debounce.
  const pending = new Map<string, { text: string; id: ReturnType<typeof setTimeout> }>();
  // The text whose autosave failed: it is not tried again until the person edits further.
  const failed = new Map<string, string>();
  const io: FileIo = { api, store, t };

  function drop(k: string): void {
    const p = pending.get(k);
    if (p) clearTimeout(p.id);
    pending.delete(k);
  }

  function reconcile(): void {
    const { autosave, autosaveMs } = getEditorSettings();
    const open = new Set<string>();
    for (const e of store.all()) {
      const k = `${e.worktree}\0${e.rel}`;
      open.add(k);
      // A save in flight is left alone: its result clears the dirty state, or an edit made meanwhile
      // schedules the next one.
      if (e.saving) continue;
      if (!autosave || !isDirty(e) || e.conflict !== null) {
        drop(k);
        continue;
      }
      if (pending.get(k)?.text === e.text || failed.get(k) === e.text) continue;
      drop(k);
      pending.set(k, {
        text: e.text,
        id: setTimeout(() => {
          pending.delete(k);
          void saveFile(io, e.worktree, e.rel).then((r) => {
            // The failure's own change event already queued a retry; cancel it.
            if (r !== "failed") return;
            failed.set(k, e.text);
            drop(k);
          });
        }, autosaveMs),
      });
    }
    for (const k of [...pending.keys()]) if (!open.has(k)) drop(k);
  }

  const stops = [store.subscribe(reconcile), subscribeEditorSettings(reconcile)];
  reconcile();
  return () => {
    for (const stop of stops) stop();
    for (const k of [...pending.keys()]) drop(k);
  };
}
