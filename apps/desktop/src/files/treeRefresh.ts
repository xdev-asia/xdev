import type { FsEvent } from "@/api";
import { parentOf } from "./treeActions";

/**
 * The loaded folders whose listing an event batch changed: the parent of each created or deleted
 * entry. An update to a file changes no listing. An overflow means the batch is incomplete, so
 * every loaded folder is read again.
 */
export function dirsToReload(events: FsEvent[], loaded: ReadonlySet<string>): string[] | "all" {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === "overflow") return "all";
    if (e.kind === "update") continue;
    const dir = parentOf(e.rel);
    if (loaded.has(dir)) out.add(dir);
  }
  return [...out];
}

/** One delivered batch, numbered in arrival order. */
export interface FsBatch {
  seq: number;
  events: FsEvent[];
}

/** The batches of one worktree not yet dropped; a new object on each change, so React sees it. */
export interface WatchQueue {
  worktree: string | null;
  batches: FsBatch[];
  /** The highest `seq` dropped to keep the queue short; 0 when none was. */
  dropped: number;
}

/** A reader this far behind has missed batches; it reads everything again instead. */
export const MAX_QUEUED = 64;

let seq = 0;

export function emptyQueue(worktree: string | null): WatchQueue {
  return { worktree, batches: [], dropped: 0 };
}

/** `queue` with `events` added at the end; the oldest batches go past `MAX_QUEUED`. */
export function enqueue(queue: WatchQueue, events: FsEvent[]): WatchQueue {
  const batches = [...queue.batches, { seq: ++seq, events }];
  const cut = Math.max(0, batches.length - MAX_QUEUED);
  const dropped = cut > 0 ? batches[cut - 1]!.seq : queue.dropped;
  return { worktree: queue.worktree, batches: batches.slice(cut), dropped };
}

const OVERFLOW: FsEvent = { kind: "overflow", rel: "", dir: null };

/**
 * The events of `worktree` after batch `seen`, oldest first, and the new `seen`. A reader that has
 * seen some batches and missed dropped ones gets an overflow. `seen` 0 is a reader that just came.
 */
export function drain(queue: WatchQueue, worktree: string, seen: number): { events: FsEvent[]; seen: number } {
  if (queue.worktree !== worktree) return { events: [], seen };
  const fresh = queue.batches.filter((b) => b.seq > seen);
  const events = fresh.flatMap((b) => b.events);
  if (seen > 0 && seen < queue.dropped) events.unshift(OVERFLOW);
  return { events, seen: fresh.at(-1)?.seq ?? seen };
}
