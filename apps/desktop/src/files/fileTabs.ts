// File tabs live in the pane tree beside terminals and the review tab. Their id is `file:<rel>`;
// terminal ids never contain a colon, so the prefix cannot clash.
export const FILE_TAB = "file:";

/** The pane-tree id of the tab showing `rel` (relative to the worktree, forward slashes). */
export function fileTabId(rel: string): string {
  return FILE_TAB + rel;
}

export function isFileTab(id: string): boolean {
  return id.startsWith(FILE_TAB);
}

/** The relative path a file tab shows; null for any other tab. */
export function fileTabRel(id: string): string | null {
  return isFileTab(id) ? id.slice(FILE_TAB.length) : null;
}
