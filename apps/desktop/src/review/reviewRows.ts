import { pathRows, type TreeRow } from "@xdev-asia/ui";
import type { ReviewFile } from "@/api";

/**
 * The review tree rows. Every file keeps its status letter; a folder gets the changed dot only when it
 * holds a file with unstaged changes, so a fully staged review does not light every folder. Chains of single
 * folders are merged; the merged row has the id of the deepest folder, which is dirty whenever an ancestor is.
 */
export function reviewRows(files: Pick<ReviewFile, "path" | "kind" | "unstaged">[], closed: ReadonlySet<string>): TreeRow[] {
  const dirty = new Set<string>();
  for (const f of files) {
    if (!f.unstaged) continue;
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirty.add(`${parts.slice(0, i).join("/")}/`);
  }
  return pathRows(files.map((f) => ({ path: f.path, mark: f.kind })), closed, { compact: true }).map((r) => {
    if (r.kind !== "dir") return r;
    const { changed: _was, ...rest } = r;
    return dirty.has(r.id) ? { ...rest, changed: true } : rest;
  });
}
