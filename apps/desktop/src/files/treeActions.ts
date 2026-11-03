import { toApiError, type Api } from "@/api";
import { pushToast } from "@/workspace/toastStore";
import { copyText } from "@/ui/clipboard";
import { openFile } from "./openFile";
import { fileName, type FileTabs } from "./fileTabs";

/** What the tree's menu needs besides the entry: the backend, the open files and the translator. */
export interface TreeIo {
  api: Api;
  store: FileTabs;
  worktree: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export const parentOf = (rel: string): string => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
export const joinRel = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

const fail = ({ t }: TreeIo, id: string, e: unknown) => pushToast({ id, text: t(`error.${toApiError(e).code}`) });

/** The absolute path of `rel` in the worktree, as the platform writes it. */
export function absolutePath(worktree: string, rel: string): string {
  const root = worktree.replace(/[\\/]+$/, "");
  const sep = worktree.includes("\\") ? "\\" : "/";
  return root + sep + rel.split("/").join(sep);
}

export const copyAbsolute = (io: TreeIo, rel: string): Promise<boolean> => copyText(absolutePath(io.worktree, rel));
export const copyRelative = (rel: string): Promise<boolean> => copyText(rel.replaceAll("\\", "/"));

/** Creates `name` in `dir`; a new file opens in an editor. Resolves with the folder to read again, or null. */
export async function createEntry(io: TreeIo, dir: string, name: string, isDir: boolean): Promise<string | null> {
  const rel = joinRel(dir, name);
  try {
    await io.api.fileCreate(io.worktree, rel, isDir);
  } catch (e) {
    fail(io, `file-create:${rel}`, e);
    return null;
  }
  if (!isDir) openFile({ worktree: io.worktree, rel });
  return dir;
}

/** Renames `rel` to `name` beside it; open tabs under it follow. Resolves with the folder, or null. */
export async function renameEntry(io: TreeIo, rel: string, name: string): Promise<string | null> {
  const dir = parentOf(rel);
  const to = joinRel(dir, name);
  try {
    await io.api.fileRename(io.worktree, rel, to);
  } catch (e) {
    fail(io, `file-rename:${rel}`, e);
    return null;
  }
  io.store.rename(io.worktree, rel, to);
  return dir;
}

/** Moves `rel` to the trash; open tabs under it close, and a toast says it went. */
export async function deleteEntry(io: TreeIo, rel: string): Promise<string | null> {
  try {
    await io.api.fileTrash(io.worktree, rel);
  } catch (e) {
    fail(io, `file-trash:${rel}`, e);
    return null;
  }
  for (const e of io.store.under(io.worktree, rel)) io.store.close(io.worktree, e.rel);
  pushToast({ id: `file-trash:${rel}`, text: io.t("files.deleted", { name: fileName(rel) }) });
  return parentOf(rel);
}
