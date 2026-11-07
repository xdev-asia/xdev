// Deleting a task with an undo window. The task is hidden at once and kept on disk; the file is
// removed only when the window ends. A crash or a forced quit inside the window leaves the task
// as it was, and Undo restores it exactly (same id, column, order and fields) with no write.

import type { Api } from "@/api";
import { DEFAULT_TTL_MS, dismissToast, pushToast } from "@/workspace/toastStore";

type DeleteApi = Pick<Api, "boardDelete">;

/** How long Undo is offered: as long as the toast shows. */
export const UNDO_MS = DEFAULT_TTL_MS;

export interface DeleteText {
  deleted: string;
  undo: string;
  failed: string;
}

interface Pending {
  run(): Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  /** The delete is on its way: no second run, no undo. */
  started: boolean;
}

const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
let version = 0;

let hooked = false;

/** Closing the window ends the undo window: what is waiting is deleted then, best effort. */
function hookPageHide(): void {
  if (hooked || typeof window === "undefined") return;
  hooked = true;
  window.addEventListener("pagehide", flushPendingDeletes);
}

const keyOf = (repo: string, id: string): string => `${repo}\n${id}`;
const toastOf = (repo: string, id: string): string => `board-deleted:${keyOf(repo, id)}`;

function emit(): void {
  version += 1;
  for (const l of [...listeners]) l();
}

export function isPendingDelete(repo: string, id: string): boolean {
  return pending.has(keyOf(repo, id));
}

/** Changes on every hide or show, for `useSyncExternalStore`. */
export function pendingDeleteVersion(): number {
  return version;
}

export function subscribePendingDeletes(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Hides the task and offers Undo for `UNDO_MS`; then deletes the file. The task stays hidden
 * until `committed` (the board's reload) resolves, so it does not flash back before the list
 * is read again. A failed delete shows it again with `text.failed`.
 */
export function deleteTask(api: DeleteApi, repo: string, id: string, text: DeleteText, committed: () => Promise<void> = async () => {}): void {
  const key = keyOf(repo, id);
  if (pending.has(key)) return;
  hookPageHide();
  const toast = toastOf(repo, id);
  const run = async (): Promise<void> => {
    const entry = pending.get(key);
    if (!entry || entry.run !== run || entry.started) return;
    entry.started = true;
    clearTimeout(entry.timer);
    dismissToast(toast);
    let failed = false;
    try {
      await api.boardDelete(repo, id);
    } catch {
      failed = true;
    }
    try {
      await committed();
    } catch {
      // The next poll reads the list again.
    }
    pending.delete(key);
    emit();
    if (failed) pushToast({ id: `board-delete-failed:${key}`, text: text.failed });
  };
  pending.set(key, { run, timer: setTimeout(() => void run(), UNDO_MS), started: false });
  pushToast({ id: toast, text: text.deleted, actions: [{ label: text.undo, run: () => undoDelete(repo, id) }], ttlMs: UNDO_MS });
  emit();
}

/** Shows the task again and keeps its file. False when it was not waiting, or its delete has begun. */
export function undoDelete(repo: string, id: string): boolean {
  const key = keyOf(repo, id);
  const entry = pending.get(key);
  if (!entry || entry.started) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  dismissToast(toastOf(repo, id));
  emit();
  return true;
}

/** Deletes every waiting task now: the window is closing, so Undo can no longer be pressed. */
export function flushPendingDeletes(): void {
  for (const entry of [...pending.values()]) void entry.run();
}

/** Tests only. */
export function resetPendingDeletesForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  listeners.clear();
  version = 0;
}
