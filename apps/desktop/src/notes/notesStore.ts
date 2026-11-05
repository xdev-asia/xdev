import { useEffect, useSyncExternalStore } from "react";
import type { Api, Note } from "@/api";

type NotesApi = Pick<Api, "notesList" | "notesPut" | "notesDelete">;

export interface NotesState {
  /** Tab id → its note; blank notes are not held. */
  byTab: ReadonlyMap<string, Note>;
  loaded: boolean;
}

/** The notes the app knows, kept in step with what the store in Rust holds. */
export function createNotesStore(api: NotesApi) {
  let state: NotesState = { byTab: new Map(), loaded: false };
  let loading = false;
  const listeners = new Set<() => void>();
  const set = (byTab: Map<string, Note>, loaded = true) => {
    state = { byTab, loaded };
    for (const cb of listeners) cb();
  };
  const store = {
    state: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Reads the list once; a read that fails leaves it empty (notes then show nothing, never block a tab). */
    load(): void {
      if (state.loaded || loading) return;
      loading = true;
      api.notesList().then(
        (list) => set(new Map(list.map((n) => [n.tab, n]))),
        () => set(new Map()),
      ).finally(() => (loading = false));
    },
    /** Saves; a blank body removes the note. Rejects with the api error (`bad_note`) so the editor can say it. */
    async save(note: Note): Promise<Note | null> {
      const saved = await api.notesPut(note);
      const next = new Map(state.byTab);
      if (saved) next.set(note.tab, saved);
      else next.delete(note.tab);
      set(next);
      return saved;
    },
    async remove(tab: string): Promise<void> {
      await api.notesDelete(tab);
      const next = new Map(state.byTab);
      next.delete(tab);
      set(next);
    },
  };
  return store;
}

export type NotesStore = ReturnType<typeof createNotesStore>;

const stores = new WeakMap<object, NotesStore>();

export function notesStoreOf(api: NotesApi): NotesStore {
  let s = stores.get(api);
  if (!s) {
    s = createNotesStore(api);
    stores.set(api, s);
  }
  return s;
}

/** The notes of `api`, loaded on first use. */
export function useNotes(api: NotesApi): { state: NotesState; store: NotesStore } {
  const store = notesStoreOf(api);
  const state = useSyncExternalStore(store.subscribe, store.state, store.state);
  useEffect(() => store.load(), [store]);
  return { state, store };
}
