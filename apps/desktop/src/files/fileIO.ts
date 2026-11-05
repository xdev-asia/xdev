import { toApiError, type Api } from "@/api";
import { pushToast } from "@/workspace/toastStore";
import { fileName, isDirty, type FileTabs } from "./fileTabs";

/** Reads the file into its open entry (the first read, or a reload that drops the edits). */
export async function loadFile({ api, store }: FileIo, worktree: string, rel: string): Promise<void> {
  try {
    store.loaded(worktree, rel, await api.fileRead(worktree, rel));
  } catch (e) {
    store.failed(worktree, rel, toApiError(e).code);
  }
}

/**
 * Reads the file again and drops the edits. A read that fails changes nothing and is a toast, so a
 * file that is gone keeps the text in the editor. Resolves true when the buffer was replaced.
 */
export async function reloadFile({ api, store, t }: FileIo, worktree: string, rel: string): Promise<boolean> {
  try {
    store.loaded(worktree, rel, await api.fileRead(worktree, rel));
    return true;
  } catch (e) {
    pushToast({ id: `file-reload:${worktree}:${rel}`, text: t(`error.${toApiError(e).code}`) });
    return false;
  }
}

/** `reloadFile`; when edits were dropped, a toast offers Undo, which puts them back. */
export async function reloadWithUndo(io: FileIo, worktree: string, rel: string): Promise<boolean> {
  const before = io.store.get(worktree, rel);
  const snap = before && isDirty(before) ? { text: before.text, saved: before.saved, hash: before.hash, eol: before.eol } : null;
  const done = await reloadFile(io, worktree, rel);
  if (done && snap) {
    pushToast({
      id: `file-reload:${worktree}:${rel}`,
      text: io.t("files.external.reloaded", { name: fileName(rel) }),
      actions: [{ label: io.t("files.external.undo"), run: () => io.store.restore(worktree, rel, snap) }],
    });
  }
  return done;
}

/**
 * Keeps the edits over what is on disk. The hash found there becomes the base, so the next save is
 * on purpose; a file that is gone has none, so the next save creates it. A file that cannot be read
 * for another reason keeps its base: the next save meets the conflict again.
 */
export async function keepMineFile({ api, store }: FileIo, worktree: string, rel: string): Promise<void> {
  const entry = store.get(worktree, rel);
  if (!entry) return;
  // A conflict hash of "" means the save found the file gone.
  if (entry.conflict !== null) return store.keepMine(worktree, rel, entry.conflict);
  try {
    store.keepMine(worktree, rel, (await api.fileRead(worktree, rel)).hash ?? undefined);
  } catch (e) {
    store.keepMine(worktree, rel, toApiError(e).code === "not_found" ? null : undefined);
  }
}

/** Writes the edits over the newer disk version: the hash found there is the one replaced. */
export async function overwriteFile(io: FileIo, worktree: string, rel: string): Promise<SaveResult> {
  const entry = io.store.get(worktree, rel);
  if (!entry) return "skipped";
  if (entry.conflict === null) await keepMineFile(io, worktree, rel);
  return saveFile(io, worktree, rel, io.store.get(worktree, rel)?.conflict !== null);
}

/** What the file helpers need: the backend, the store and the translator for error toasts. */
export interface FileIo {
  api: Api;
  store: FileTabs;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export type SaveResult = "saved" | "conflict" | "failed" | "skipped";

/**
 * Writes the editor's text, guarded by the hash it loaded. `overwrite` writes over a conflict: it
 * names the hash found on disk, so only that version is replaced. A conflict marks the entry and
 * writes nothing; any other failure is a toast.
 */
export async function saveFile({ api, store, t }: FileIo, worktree: string, rel: string, overwrite = false): Promise<SaveResult> {
  const entry = store.get(worktree, rel);
  if (!entry || entry.status !== "ready" || entry.kind !== "text" || entry.saving) return "skipped";
  if (entry.conflict && !overwrite) return "skipped";
  const text = entry.text;
  // A conflict hash of "" means the file is gone: overwriting creates it (no hash to match).
  const expected = overwrite ? entry.conflict || null : entry.hash;
  store.setSaving(worktree, rel, true);
  try {
    const out = await api.fileWrite(worktree, rel, text, entry.eol, expected);
    if (out.type === "conflict") {
      store.conflict(worktree, rel, out.diskHash);
      return "conflict";
    }
    store.saved(worktree, rel, text, out.hash);
    return "saved";
  } catch (e) {
    store.setSaving(worktree, rel, false);
    pushToast({ id: `file-save:${worktree}:${rel}`, text: t(`error.${toApiError(e).code}`) });
    return "failed";
  }
}
