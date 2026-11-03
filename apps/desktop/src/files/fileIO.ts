import { toApiError, type Api } from "@/api";
import { pushToast } from "@/workspace/toastStore";
import type { FileTabs } from "./fileTabs";

/** Reads the file into its open entry (the first read, or a reload that drops the edits). */
export async function loadFile({ api, store }: FileIo, worktree: string, rel: string): Promise<void> {
  try {
    store.loaded(worktree, rel, await api.fileRead(worktree, rel));
  } catch (e) {
    store.failed(worktree, rel, toApiError(e).code);
  }
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
  const expected = overwrite ? entry.conflict : entry.hash;
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
