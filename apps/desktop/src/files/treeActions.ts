import { toApiError, type Api } from "@/api";
import { pushToast } from "@/workspace/toastStore";
import { copyText } from "@/ui/clipboard";
import type { MenuItem } from "@/ui/ContextMenu";
import { requestSearch } from "@/search/searchPrefill";
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

/** Whether dropping `rel` into the folder `destDir` moves anything: not into its own folder, nor into itself. */
export function canMove(rel: string, destDir: string): boolean {
  if (parentOf(rel) === destDir) return false;
  return destDir !== rel && !destDir.startsWith(`${rel}/`);
}

/**
 * Moves `rel` into the folder `destDir` under its own name; open tabs under it follow. With `replace`
 * a taken name is moved to the trash first. Resolves with the folders to read again, "exists" when the
 * name is taken and `replace` is off, or null when it failed (a toast says why).
 */
export async function moveEntry(io: TreeIo, rel: string, destDir: string, replace = false): Promise<string[] | "exists" | null> {
  if (!canMove(rel, destDir)) return null;
  const to = joinRel(destDir, fileName(rel));
  try {
    if (replace) await io.api.fileTrash(io.worktree, to);
    await io.api.fileRename(io.worktree, rel, to);
  } catch (e) {
    if (!replace && toApiError(e).code === "exists") return "exists";
    fail(io, `file-move:${rel}`, e);
    return null;
  }
  // A tab of the file that was replaced is gone with it.
  if (replace) for (const e of io.store.under(io.worktree, to)) io.store.close(io.worktree, e.rel);
  io.store.rename(io.worktree, rel, to);
  return [parentOf(rel), destDir];
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

/** The search's include glob for a folder: `src/**`, with `/` between names; the worktree root is `**`. */
export function folderGlob(dir: string): string {
  const clean = dir.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return clean === "" ? "**" : `${clean}/**`;
}

/** Opens the search filled in for the folder `dir`. */
export const findInFolder = (dir: string): void => requestSearch({ include: folderGlob(dir) });

/** What a tree menu does; the tree supplies each one. */
export interface TreeMenuHandlers {
  open(rel: string): void;
  copyPath(rel: string): void;
  copyRel(rel: string): void;
  findIn(dir: string): void;
  openTerminal(dir: string): void;
  ask(a: { kind: "newFile" | "newFolder" | "rename"; dir: string; rel?: string } | { kind: "delete"; rel: string }): void;
  reveal(rel: string): void;
  openOnHost(rel: string): void;
}

/** The menu of a row, or of the tree's empty space (`target` null, the worktree root). */
export function treeMenuItems(target: { rel: string; dir: boolean } | null, h: TreeMenuHandlers): MenuItem[] {
  const dirOf = target === null ? "" : target.dir ? target.rel : parentOf(target.rel);
  const items: MenuItem[] = [];
  if (target && !target.dir) items.push({ id: "open", labelKey: "files.menu.open", run: () => h.open(target.rel) });
  if (target) {
    items.push(
      { id: "copyPath", labelKey: "files.menu.copyPath", run: () => h.copyPath(target.rel) },
      { id: "copyRel", labelKey: "files.menu.copyRelativePath", run: () => h.copyRel(target.rel) },
      { id: "sep1", labelKey: "", kind: "separator" },
    );
  }
  items.push(
    { id: "findInFolder", labelKey: "files.menu.findInFolder", run: () => h.findIn(dirOf) },
    { id: "openInTerminal", labelKey: "files.menu.openInTerminal", run: () => h.openTerminal(dirOf) },
    { id: "newFile", labelKey: "files.menu.newFile", run: () => h.ask({ kind: "newFile", dir: dirOf }) },
    { id: "newFolder", labelKey: "files.menu.newFolder", run: () => h.ask({ kind: "newFolder", dir: dirOf }) },
  );
  if (target) {
    items.push(
      { id: "rename", labelKey: "files.menu.rename", run: () => h.ask({ kind: "rename", dir: parentOf(target.rel), rel: target.rel }) },
      { id: "delete", labelKey: "files.menu.delete", danger: true, run: () => h.ask({ kind: "delete", rel: target.rel }) },
      { id: "sep2", labelKey: "", kind: "separator" },
      { id: "reveal", labelKey: "files.menu.reveal", run: () => h.reveal(target.rel) },
    );
    if (!target.dir) items.push({ id: "openOnHost", labelKey: "files.menu.openOnHost", run: () => h.openOnHost(target.rel) });
  }
  return items;
}
