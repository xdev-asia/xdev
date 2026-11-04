import type { PtyProfile, RestoreMode } from "@/api";
import { leaves, removeTab, replaceTab, type PaneLayout } from "./paneTree";
import type { Tab, TabCli, TabColor } from "./sessions";

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

const REVIEW_ID = "review:";
const FILE_ID = "file:";

/** Tabs that are not terminal sessions: they keep their pane id as their snapshot id. */
const isPlace = (id: string) => id === REVIEW_ID || id.startsWith(FILE_ID);
// The setup script's tab (`xdev:` profiles) must not run its script again on a restart.
const isSetup = (tab: Tab) => tab.profileId.startsWith("xdev:");

/**
 * One worktree's layout and tabs as the snapshot keeps them: terminal ids become `t1`, `t2`, … in
 * reading order; the review and file tabs keep their ids. A terminal that exited, is unknown or is a
 * setup tab is left out and its pane collapses. Null when nothing is left to keep.
 */
export function toSnapshot(layout: PaneLayout, tabOf: (id: string) => Tab | null): WorktreeSnapshot | null {
  const ids = leaves(layout).flatMap((n) => (n.kind === "leaf" ? n.tabs : []));
  let next: PaneLayout | null = layout;
  const tabs: Record<string, TabSnapshot> = {};
  const live: { id: string; tab: Tab }[] = [];
  for (const id of ids) {
    if (id === REVIEW_ID) tabs[id] = { kind: "review" };
    else if (id.startsWith(FILE_ID)) tabs[id] = { kind: "file", rel: id.slice(FILE_ID.length) };
    else {
      const tab = tabOf(id);
      if (tab && tab.exitCode === undefined && !isSetup(tab)) live.push({ id, tab });
      else next = next && removeTab(next, id);
    }
  }
  if (!next) return null;
  live.forEach(({ id, tab }, i) => {
    const to = `t${i + 1}`;
    next = next && replaceTab(next, id, to);
    tabs[to] = {
      kind: "terminal",
      profileId: tab.profileId,
      account: tab.account,
      cli: tab.cli,
      title: tab.title,
      renamed: tab.renamed,
      pinned: tab.pinned,
      color: tab.color,
      agent: tab.agent,
      agentSession: tab.agentSession,
      openedAt: tab.openedAt,
    };
  });
  return next ? { layout: next, tabs } : null;
}

/**
 * The snapshot's layout with the ids of the tabs that came back: `ids` maps a snapshot id to its new
 * one. A tab that did not come back (a skipped shell, a file that is gone) leaves its pane; the review
 * and file tabs not in `ids` keep their own id when `keep` says so. Null when no tab is left.
 */
export function fromSnapshot(layout: PaneLayout, ids: ReadonlyMap<string, string>, keep: (id: string) => boolean): PaneLayout | null {
  const all = leaves(layout).flatMap((n) => (n.kind === "leaf" ? n.tabs : []));
  let next: PaneLayout | null = layout;
  for (const id of all) {
    const to = ids.get(id);
    if (to !== undefined) next = next && replaceTab(next, id, to);
    else if (!(isPlace(id) && keep(id))) next = next && removeTab(next, id);
  }
  return next;
}
