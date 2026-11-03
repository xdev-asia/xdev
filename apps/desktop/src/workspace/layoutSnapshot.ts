import type { PtyProfile, RestoreMode } from "@/api";
import type { PaneLayout } from "./paneTree";
import type { TabCli, TabColor } from "./sessions";

// What `layout.json` holds: per worktree, its pane layout and enough of each tab to open it again.
// The UI owns this shape; the backend checks only `version` and size (plan R3).

/** `LAYOUT_VERSION` in `layout.rs`; a snapshot of any other version is refused by the backend. */
export const LAYOUT_VERSION = 1;

export interface LayoutSnapshot {
  version: 1;
  /** When it was taken, in ms. */
  savedAt: number;
  /** Key: the worktree path. */
  worktrees: Record<string, WorktreeSnapshot>;
}

export interface WorktreeSnapshot {
  /** The tab ids inside are the snapshot's own ids, the keys of `tabs`. */
  layout: PaneLayout;
  /** Key: the snapshot tab id (`t1`, `t2`, … for terminals, `review:`, `file:<rel>`). */
  tabs: Record<string, TabSnapshot>;
}

/**
 * One tab. A terminal comes back as a resume of `agentSession` (agents) or a fresh shell in the same
 * worktree (R1). A file tab comes back as the file read from disk again: edits that were not saved are
 * not part of the snapshot.
 */
export type TabSnapshot =
  | {
      kind: "terminal";
      profileId: PtyProfile;
      account: string | null;
      cli?: TabCli;
      title: string | null;
      renamed: boolean;
      pinned: boolean;
      color: TabColor;
      agent: boolean;
      agentSession: string | null;
      /** When the tab was opened, in ms; the fallback looks for sessions that started after it. */
      openedAt: number;
    }
  | { kind: "review" }
  | { kind: "file"; rel: string };

/**
 * The newest resumable session of `cli` in `worktree` that started at or after `since` (ms), for an
 * agent tab whose hooks never sent its id; null when there is none.
 */
export type SessionFallback = (worktree: string, cli: TabCli, since: number) => Promise<string | null>;

export interface RestoreReport {
  /** Agent tabs that came back as their own conversation. */
  resumed: number;
  /** Tabs that came back as a new process: shells, and agents with no session to resume. */
  fresh: number;
  skipped: { worktree: string; reason: "unknownWorktree" | "noSession" }[];
}

export type { RestoreMode };
