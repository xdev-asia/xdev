import { useEffect, useRef, useSyncExternalStore } from "react";
import { toApiError, type Api, type ReviewNote } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { deleteNote, editNote, markSent, newNote, reanchor } from "./notes";

/** How long a deleted note can be brought back. */
export const UNDO_MS = 5000;

export type NotesSnapshot = {
  notes: ReviewNote[];
  /** The note just deleted, while Undo is on offer. */
  removed: ReviewNote | null;
  problem: Problem | null;
  /** The first read has returned, well or not. */
  loaded: boolean;
};

/**
 * The review notes of one worktree. Every change goes to disk in one put; the list on screen
 * changes at once and goes back when the put fails. Puts run one after another.
 */
export class NotesStore {
  private state: NotesSnapshot = { notes: [], removed: null, problem: null, loaded: false };
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Only a read that worked allows writes: a put of a list that never loaded would wipe the file. */
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: Api,
    private readonly worktree: string,
    private readonly clock: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): NotesSnapshot => this.state;

  /** Stops the Undo timer; the store stays usable, so a re-run effect can load it again. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(patch: Partial<NotesSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  async load(): Promise<void> {
    try {
      const notes = await this.api.reviewNotes(this.worktree);
      this.ready = true;
      this.set({ notes, loaded: true, problem: null });
    } catch (e) {
      this.set({ loaded: true, problem: toApiError(e) });
    }
  }

  /** Shows `next` now and writes it; on a failed write the list goes back and says why. */
  private commit(next: ReviewNote[]): Promise<void> {
    if (!this.ready) return Promise.resolve();
    const before = this.state.notes;
    this.set({ notes: next });
    const run = async () => {
      try {
        await this.api.reviewNotesPut(this.worktree, next);
        this.set({ problem: null });
      } catch (e) {
        // Only undo what this write added, when nothing newer replaced it.
        if (this.state.notes === next) this.set({ notes: before });
        this.set({ problem: toApiError(e) });
      }
    };
    const done = this.queue.then(run, run);
    this.queue = done;
    return done;
  }

  add(file: string, startLine: number, line: number, anchor: string, body: string): Promise<void> {
    if (body.trim() === "") return Promise.resolve();
    return this.commit([...this.state.notes, newNote(file, startLine, line, anchor, body, this.clock())]);
  }

  edit(id: string, body: string): Promise<void> {
    if (body.trim() === "") return Promise.resolve();
    return this.commit(this.state.notes.map((n) => (n.id === id ? editNote(n, body) : n)));
  }

  remove(id: string): Promise<void> {
    const gone = this.state.notes.find((n) => n.id === id);
    if (!gone) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.set({ removed: gone });
    this.timer = setTimeout(() => this.set({ removed: null }), UNDO_MS);
    return this.commit(deleteNote(this.state.notes, id));
  }

  undo(): Promise<void> {
    const back = this.state.removed;
    if (!back) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.set({ removed: null });
    if (this.state.notes.some((n) => n.id === back.id)) return Promise.resolve();
    return this.commit([...this.state.notes, back]);
  }

  markSent(ids: string[]): Promise<void> {
    return this.commit(markSent(this.state.notes, ids, this.clock()));
  }

  /** Checks the notes of one file against its new text (`null` when the file is gone); one put when anything moved. */
  reanchorFile(file: string, text: string | null): Promise<void> {
    const next = reanchor(this.state.notes, file, text);
    if (!next.changed) return Promise.resolve();
    return this.commit(next.notes);
  }
}

export type ReviewNotes = NotesSnapshot & Pick<NotesStore, "add" | "edit" | "remove" | "undo" | "markSent" | "reanchorFile">;

/** The notes of `worktree`; the store is made again for another worktree or api. */
export function useReviewNotes(api: Api, worktree: string): ReviewNotes {
  const held = useRef<{ api: Api; worktree: string; store: NotesStore } | null>(null);
  if (!held.current || held.current.api !== api || held.current.worktree !== worktree) {
    held.current = { api, worktree, store: new NotesStore(api, worktree) };
  }
  const { store } = held.current;
  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);
  const snap = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return {
    ...snap,
    add: store.add.bind(store),
    edit: store.edit.bind(store),
    remove: store.remove.bind(store),
    undo: store.undo.bind(store),
    markSent: store.markSent.bind(store),
    reanchorFile: store.reanchorFile.bind(store),
  };
}
