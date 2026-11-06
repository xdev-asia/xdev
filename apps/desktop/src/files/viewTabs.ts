// A file can show in a second pane. Its tab id is `view:<rel>`; terminal ids never contain a colon, so
// the prefix cannot clash with them, `file:`, `preview:` or `review:`. A view shows the same entry as
// `file:<rel>`; there is one view per file.
export const VIEW_TAB = "view:";

/** The pane-tree id of the second view of `rel` (relative to the worktree, forward slashes). */
export function viewTabId(rel: string): string {
  return VIEW_TAB + rel;
}

export function isViewTab(id: string): boolean {
  return id.startsWith(VIEW_TAB);
}

/** The relative path a view tab shows; null for any other tab. */
export function viewTabRel(id: string): string | null {
  return isViewTab(id) ? id.slice(VIEW_TAB.length) : null;
}
