import { useSyncExternalStore } from "react";
import type { Eol, FileKind, FileText } from "@/api";

// File tabs live in the pane tree beside terminals and the review tab. Their id is `file:<rel>`;
// terminal ids never contain a colon, so the prefix cannot clash.
export const FILE_TAB = "file:";

/** The pane-tree id of the tab showing `rel` (relative to the worktree, forward slashes). */
export function fileTabId(rel: string): string {
  return FILE_TAB + rel;
}

export function isFileTab(id: string): boolean {
  return id.startsWith(FILE_TAB);
}

/** The relative path a file tab shows; null for any other tab. */
export function fileTabRel(id: string): string | null {
  return isFileTab(id) ? id.slice(FILE_TAB.length) : null;
}

/** The file name a tab shows: the last part of `rel`. */
export function fileName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** Where the editor should put the caret after a load; a new `seq` asks again. */
export interface Goto {
  line: number;
  column?: number;
  seq: number;
}

/** One open file. Entries are replaced, never changed, so a snapshot stays valid. */
export interface FileEntry {
  worktree: string;
  rel: string;
  // `loading` until the first read answers; `error` when the read was refused (`error` has the code).
  status: "loading" | "ready" | "error";
  error?: string;
  kind: FileKind;
  /** The editor's text (what would be saved). */
  text: string;
  /** The text as last read or written; `text !== saved` is the dirty mark. */
  saved: string;
  /** The hash the editor loaded or last wrote; null for a file that is not text. */
  hash: string | null;
  eol: Eol;
  /** Set when a save found the file changed on disk: the hash that is there now. */
  conflict: string | null;
  saving: boolean;
  goto?: Goto;
}

export const isDirty = (e: FileEntry): boolean => e.status === "ready" && e.kind === "text" && e.text !== e.saved;

const key = (worktree: string, rel: string) => `${worktree}\0${rel}`;

/** Every open file of every worktree. The views read it; saving and loading are the callers'. */
export class FileTabs {
  private readonly entries = new Map<string, FileEntry>();
  // Per worktree, the open rels in the order they opened; replaced on a change so it is a snapshot.
  private readonly lists = new Map<string, FileEntry[]>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  get(worktree: string, rel: string): FileEntry | null {
    return this.entries.get(key(worktree, rel)) ?? null;
  }

  /** The open files of a worktree, oldest first; the same array until one changes. */
  list(worktree: string): FileEntry[] {
    let list = this.lists.get(worktree);
    if (!list) {
      list = [...this.entries.values()].filter((e) => e.worktree === worktree);
      this.lists.set(worktree, list);
    }
    return list;
  }

  private put(entry: FileEntry): void {
    this.entries.set(key(entry.worktree, entry.rel), entry);
    this.lists.delete(entry.worktree);
    this.emit();
  }

  /** Adds the file, or points an open one at `line`. Returns true when it was not open. */
  open(worktree: string, rel: string, at?: { line?: number; column?: number }): boolean {
    const old = this.get(worktree, rel);
    const goto: Goto | undefined = at?.line ? { line: at.line, column: at.column, seq: ++this.seq } : old?.goto;
    if (old) {
      if (goto !== old.goto) this.put({ ...old, goto });
      return false;
    }
    this.put({ worktree, rel, status: "loading", kind: "text", text: "", saved: "", hash: null, eol: "lf", conflict: null, saving: false, goto });
    return true;
  }

  /** The first read (or a reload) answered. Drops the edits and any conflict. */
  loaded(worktree: string, rel: string, file: FileText): void {
    const old = this.get(worktree, rel);
    if (!old) return;
    const text = file.text ?? "";
    this.put({ ...old, status: "ready", error: undefined, kind: file.kind, text, saved: text, hash: file.hash, eol: file.eol, conflict: null, saving: false });
  }

  failed(worktree: string, rel: string, code: string): void {
    const old = this.get(worktree, rel);
    if (old) this.put({ ...old, status: "error", error: code, saving: false });
  }

  /** The editor's text changed. */
  edit(worktree: string, rel: string, text: string): void {
    const old = this.get(worktree, rel);
    if (old && old.text !== text) this.put({ ...old, text });
  }

  setSaving(worktree: string, rel: string, saving: boolean): void {
    const old = this.get(worktree, rel);
    if (old && old.saving !== saving) this.put({ ...old, saving });
  }

  /** `text` is on disk now with `hash`; edits made while it saved stay dirty. */
  saved(worktree: string, rel: string, text: string, hash: string): void {
    const old = this.get(worktree, rel);
    if (old) this.put({ ...old, saved: text, hash, conflict: null, saving: false });
  }

  /** A save found `diskHash` on disk instead of the loaded hash; nothing was written. */
  conflict(worktree: string, rel: string, diskHash: string): void {
    const old = this.get(worktree, rel);
    if (old) this.put({ ...old, conflict: diskHash, saving: false });
  }

  close(worktree: string, rel: string): void {
    if (!this.entries.delete(key(worktree, rel))) return;
    this.lists.delete(worktree);
    this.emit();
  }

  /**
   * Follows a rename: the file `from` (or every open file under the folder `from`) is now under `to`.
   * Returns the pairs of old and new rel, so the layout can follow.
   */
  rename(worktree: string, from: string, to: string): { from: string; to: string }[] {
    const moved: { from: string; to: string }[] = [];
    const order = this.list(worktree);
    const next = order.map((e) => {
      if (e.rel !== from && !e.rel.startsWith(`${from}/`)) return e;
      const rel = to + e.rel.slice(from.length);
      moved.push({ from: e.rel, to: rel });
      return { ...e, rel };
    });
    if (moved.length === 0) return moved;
    for (const e of order) this.entries.delete(key(worktree, e.rel));
    for (const e of next) this.entries.set(key(worktree, e.rel), e);
    this.lists.delete(worktree);
    this.emit();
    return moved;
  }

  /** Every open file of every worktree. */
  all(): FileEntry[] {
    return [...this.entries.values()];
  }

  /** The open files at or under `rel` (a file, or a folder that was deleted). */
  under(worktree: string, rel: string): FileEntry[] {
    return this.list(worktree).filter((e) => e.rel === rel || e.rel.startsWith(`${rel}/`));
  }

  /** Forgets everything; for tests. */
  reset(): void {
    this.entries.clear();
    this.lists.clear();
    this.emit();
  }
}

/** The one store the app uses. */
export const fileTabs = new FileTabs();

export function useOpenFiles(worktree: string, store: FileTabs = fileTabs): FileEntry[] {
  const snap = () => store.list(worktree);
  return useSyncExternalStore(store.subscribe, snap, snap);
}

export function useFileEntry(worktree: string, rel: string, store: FileTabs = fileTabs): FileEntry | null {
  const snap = () => store.get(worktree, rel);
  return useSyncExternalStore(store.subscribe, snap, snap);
}
