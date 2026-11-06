import type { DirListing, FileList } from "@/api";

/** An `ssh://` worktree: a folder on a saved SSH host. */
export const isRemoteWorktree = (worktree: string): boolean => worktree.startsWith("ssh://");

/**
 * Folder `dir` of a remote worktree, from its whole file list (`filesList`): folders first, then
 * files, each sorted. A folder that holds no file is not listed. A cut file list may miss names.
 */
export function listingFromFiles(list: FileList, dir: string): DirListing {
  const prefix = dir === "" ? "" : `${dir}/`;
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const path of list.files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.push(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    entries: [...[...dirs].sort(byName).map((name) => ({ name, dir: true, ignored: false })), ...files.sort(byName).map((name) => ({ name, dir: false, ignored: false }))],
    truncated: list.truncated,
  };
}
