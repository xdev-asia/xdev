import { toApiError, type FsEvent } from "@/api";
import type { FileIo } from "./fileIO";
import { isDirty } from "./fileTabs";
import { viewerOf } from "./viewer";

/** The clock `reconcile` uses; tests pass their own. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Events of one file arrive in bursts; it is read once, this long after the last. */
export const RELOAD_DEBOUNCE_MS = 75;
/** A file that is gone is marked only after this long, so a save that swaps files is not taken for a delete. */
export const DELETE_SETTLE_MS = 250;

type Pending = { handle: unknown; timers: Timers };
const reads = new Map<string, Pending>();
const settles = new Map<string, Pending>();
const waits = new Map<string, () => void>();

const keyOf = (worktree: string, rel: string) => `${worktree}\0${rel}`;

/** Images and media: their view reads the bytes itself, so there is no text to compare. */
const readsItself = (rel: string) => viewerOf(rel) === "image" || viewerOf(rel) === "media";

function cancel(map: Map<string, Pending>, k: string): void {
  const p = map.get(k);
  if (p) p.timers.clear(p.handle);
  map.delete(k);
}

/** Drops every wait of `worktree` (all worktrees without one); for the view going away and for tests. */
export function resetWatchState(worktree?: string): void {
  const mine = (k: string) => worktree === undefined || k.startsWith(`${worktree}\0`);
  for (const map of [reads, settles]) for (const k of [...map.keys()]) if (mine(k)) cancel(map, k);
  for (const [k, stop] of [...waits]) {
    if (!mine(k)) continue;
    stop();
    waits.delete(k);
  }
}

function later(map: Map<string, Pending>, timers: Timers, k: string, ms: number, fn: () => void): void {
  cancel(map, k);
  map.set(k, {
    timers,
    handle: timers.set(() => {
      map.delete(k);
      fn();
    }, ms),
  });
}

function scheduleRead(io: FileIo, worktree: string, rel: string, timers: Timers): void {
  later(reads, timers, keyOf(worktree, rel), RELOAD_DEBOUNCE_MS, () => void check(io, worktree, rel, timers));
}

function scheduleDelete(io: FileIo, worktree: string, rel: string, timers: Timers): void {
  const k = keyOf(worktree, rel);
  later(settles, timers, k, DELETE_SETTLE_MS, () => {
    const entry = io.store.get(worktree, rel);
    if (entry && entry.external !== "deleted") io.store.markExternal(worktree, rel, "deleted");
  });
}

/** Re-checks `rel` once the save in flight has landed. */
function afterSave(io: FileIo, worktree: string, rel: string, timers: Timers): void {
  const k = keyOf(worktree, rel);
  if (waits.has(k)) return;
  const stop = io.store.subscribe(() => {
    const entry = io.store.get(worktree, rel);
    if (entry?.saving) return;
    stop();
    waits.delete(k);
    if (entry) void check(io, worktree, rel, timers);
  });
  waits.set(k, stop);
}

/**
 * Reads `rel` and compares it with the open buffer. The hash decides: equal means our own write or a
 * touch, so nothing happens. A clean buffer takes the new text silently; one with edits is marked
 * `changed` and keeps them.
 */
async function check(io: FileIo, worktree: string, rel: string, timers: Timers): Promise<void> {
  const { api, store } = io;
  if (readsItself(rel)) {
    // The view reads the bytes again; a mark the file came back from is cleared.
    if (store.get(worktree, rel)) store.revise(worktree, rel);
    return;
  }
  const usable = () => {
    const e = store.get(worktree, rel);
    return e && e.status === "ready" && e.kind === "text" ? e : null;
  };
  if (!usable()) return;
  if (usable()!.saving) return afterSave(io, worktree, rel, timers);
  let file;
  try {
    file = await api.fileRead(worktree, rel);
  } catch (e) {
    if (toApiError(e).code === "not_found" && usable()) scheduleDelete(io, worktree, rel, timers);
    return;
  }
  // The buffer may have been edited, saved or closed while the read was out.
  const now = usable();
  if (!now) return;
  if (now.saving) return afterSave(io, worktree, rel, timers);
  if (file.hash === now.hash) {
    if (now.external !== null) store.markExternal(worktree, rel, null);
    return;
  }
  if (isDirty(now)) store.markExternal(worktree, rel, "changed");
  else store.loaded(worktree, rel, file);
}

/**
 * Applies one batch of disk events of `worktree` to the open buffers. Which files are open is read
 * from the store; folders and unopened files cost nothing.
 */
export function reconcile(io: FileIo, worktree: string, batch: FsEvent[], timers: Timers = realTimers): void {
  const { store } = io;
  if (batch.some((e) => e.kind === "overflow")) {
    // Events were lost: every open file is read again.
    for (const e of store.list(worktree)) {
      // Reading an image or media file again would reset its zoom or playback for nothing.
      if (readsItself(e.rel) && e.external === null) continue;
      scheduleRead(io, worktree, e.rel, timers);
    }
    return;
  }
  const basename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
  const created = batch.filter((e) => e.kind === "create" && e.dir !== true);
  for (const e of batch) {
    if (e.kind === "delete") {
      for (const entry of store.under(worktree, e.rel)) {
        const moved = created.some((c) => c.rel !== entry.rel && basename(c.rel) === basename(entry.rel));
        if (moved) {
          cancel(settles, keyOf(worktree, entry.rel));
          store.markExternal(worktree, entry.rel, "renamed");
        } else {
          scheduleDelete(io, worktree, entry.rel, timers);
        }
      }
      continue;
    }
    if (e.dir === true || !store.get(worktree, e.rel)) continue;
    // Back on disk: no delete mark is due, and the content is compared.
    cancel(settles, keyOf(worktree, e.rel));
    scheduleRead(io, worktree, e.rel, timers);
  }
}
