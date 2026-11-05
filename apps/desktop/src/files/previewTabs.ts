// A Markdown preview can sit in a pane of its own. Its tab id is `preview:<rel>`; terminal ids never
// contain a colon, so the prefix cannot clash with them, `file:` or `review:`.
export const PREVIEW_TAB = "preview:";

/** The pane-tree id of the preview of `rel` (relative to the worktree, forward slashes). */
export function previewTabId(rel: string): string {
  return PREVIEW_TAB + rel;
}

export function isPreviewTab(id: string): boolean {
  return id.startsWith(PREVIEW_TAB);
}

/** The relative path a preview tab shows; null for any other tab. */
export function previewTabRel(id: string): string | null {
  return isPreviewTab(id) ? id.slice(PREVIEW_TAB.length) : null;
}
