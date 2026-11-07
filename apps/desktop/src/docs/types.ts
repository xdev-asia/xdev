export type DocsSaveState = "saved" | "unsaved" | "saving" | "loading" | "conflict";

/** What the footer shows about the open docs. */
export interface DocsStatus {
  dirty: boolean;
  save: DocsSaveState;
  docs: number;
  stale: number;
  /** `null` while the changes are unknown (loading, or the folder is not tracked). */
  changes: number | null;
}

export interface DocsHandle {
  /** Writes pending edits. Resolves `false` when some are left (conflict or a failed write). */
  flush(): Promise<boolean>;
}
