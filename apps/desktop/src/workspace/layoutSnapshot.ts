import type { AccountSource, PtyProfile, RestoreMode } from "@/api";
import { readCanvas } from "./canvas/canvasModel";
import { isLayoutPreset } from "./layoutPresets";
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
  /** The right panel's width in this window, px; absent until the person resizes it (and in older snapshots). */
  panelWidth?: number;
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
      /** The account the tab ran under when saved; with `accountSource`, how a restore treats it. */
      account: string | null;
      /** Where that account came from. Absent in older snapshots, whose `account` is the tab's own pick. */
      accountSource?: AccountSource | null;
      cli?: TabCli;
      /** The folder, relative to the worktree, the shell started in; absent for the root. */
      dir?: string;
      title: string | null;
      renamed: boolean;
      /** `title` was made from the first prompt; absent in older snapshots. */
      autoTitled?: boolean;
      pinned: boolean;
      color: TabColor;
      /** Shown as a chat over the terminal; written only when set. */
      view?: "chat";
      agent: boolean;
      agentSession: string | null;
      /** When the tab was opened, in ms; the fallback looks for sessions that started after it. */
      openedAt: number;
      /** Put to sleep: no pty runs. It comes back asleep under every restore mode and starts on wake. */
      asleep?: true;
      /** The pty id in the terminal service, which a restore attaches to first. Absent while asleep. */
      ptyId?: string;
      /** How many output bytes the tab had drawn; the attach replays from there. */
      seq?: number;
    }
  | { kind: "review" }
  | { kind: "file"; rel: string }
  /** A browser tab: it loads `url` again when it is first shown. */
  | { kind: "browser"; url: string; title?: string | null };

/**
 * The newest resumable session of `cli` in `worktree` that started at or after `since` (ms), for an
 * agent tab whose hooks never sent its id; null when there is none.
 */
export type SessionFallback = (worktree: string, cli: TabCli, since: number) => Promise<string | null>;

export interface RestoreReport {
  /** Tabs whose pty was still running in the terminal service; left out when none was. */
  attached?: number;
  /** Tabs that came back asleep; left out when none did. */
  asleep?: number;
  /** Agent tabs that came back as their own conversation. */
  resumed: number;
  /** Tabs that came back as a new process: shells, and agents with no session to resume. */
  fresh: number;
  skipped: { worktree: string; reason: "unknownWorktree" | "noSession" }[];
  /** The pty ids of the terminal tabs that were opened, for "Undo". */
  opened: string[];
}

/** What `restore` cannot know by itself. */
export interface RestoreOptions {
  /** Whether a worktree is still in the registry; left out, every worktree is. */
  known?: (worktree: string) => boolean;
  /** Opens a file tab again; true when the file is there, false (or a throw) when it is gone. Left out, file tabs are dropped. */
  /**
   * Whether the saved entry of a worktree that is not known is kept for later saves. True when the
   * registry may be incomplete (a repo is missing); left out, such entries are dropped.
   */
  carry?: (worktree: string) => boolean;
  openFile?: (worktree: string, rel: string) => Promise<boolean>;
  /** The line a terminal shows above its saved output (or instead of it); left out, English. */
  note?: (key: RestoreNote) => string;
}

export type { RestoreMode };

/** The lines a restored terminal may show above its output. */
export type RestoreNote = "ptyd.restored" | "ptyd.fresh" | "accounts.restore.gone";

/**
 * The account to open a restored terminal with. A tab keeps the account it ran under, wherever that
 * came from; only a profile's account is looked up again. `known` holds the names of the accounts
 * there are now (null when they could not be read): a saved account that is gone falls back to the
 * default (`gone`), and with no list a tab that did not pick its account itself follows the default.
 */
export function restoredAccount(snap: { account: string | null; accountSource?: AccountSource | null }, known: ReadonlySet<string> | null): { account: string | null; gone: boolean } {
  const source = snap.accountSource;
  if (snap.account === null || source === "profile") return { account: null, gone: false };
  if (known === null) return { account: source === undefined || source === "tab" ? snap.account : null, gone: false };
  return known.has(snap.account) ? { account: snap.account, gone: false } : { account: null, gone: true };
}

const REVIEW_ID = "review:";
const FILE_ID = "file:";
const BROWSER_ID = "browser:";

/** Tabs that are not terminal sessions: they keep their pane id as their snapshot id. */
const isPlace = (id: string) => id === REVIEW_ID || id.startsWith(FILE_ID);
// The setup script's tab (`xdev:` profiles) must not run its script again on a restart.
const isSetup = (tab: Tab) => tab.profileId.startsWith("xdev:");

/**
 * One worktree's layout and tabs as the snapshot keeps them: terminal ids become `t1`, `t2`, … in
 * reading order; the review and file tabs keep their ids. A terminal that exited, is unknown or is a
 * setup tab is left out and its pane collapses. Null when nothing is left to keep.
 */
export function toSnapshot(
  layout: PaneLayout,
  tabOf: (id: string) => Tab | null,
  browserOf: (id: string) => { url: string; title: string | null } | undefined = () => undefined,
): WorktreeSnapshot | null {
  const ids = leaves(layout).flatMap((n) => (n.kind === "leaf" ? n.tabs : []));
  let next: PaneLayout | null = layout;
  const tabs: Record<string, TabSnapshot> = {};
  const live: { id: string; tab: Tab }[] = [];
  for (const id of ids) {
    if (id === REVIEW_ID) tabs[id] = { kind: "review" };
    else if (id.startsWith(FILE_ID)) tabs[id] = { kind: "file", rel: id.slice(FILE_ID.length) };
    else if (id.startsWith(BROWSER_ID)) {
      const page = browserOf(id);
      if (page) tabs[id] = { kind: "browser", url: page.url, ...(page.title ? { title: page.title } : {}) };
      else next = next && removeTab(next, id);
    } else {
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
      // The account in use and where it came from: a restore follows the active account again only
      // while it is still the one the tab ran under (see `restoredAccount`).
      account: tab.account,
      accountSource: tab.accountSource,
      cli: tab.cli,
      ...(tab.dir ? { dir: tab.dir } : {}),
      title: tab.title,
      renamed: tab.renamed,
      ...(tab.autoTitled ? { autoTitled: true } : {}),
      pinned: tab.pinned,
      color: tab.color,
      ...(tab.view ? { view: tab.view } : {}),
      agent: tab.agent,
      agentSession: tab.agentSession,
      openedAt: tab.openedAt,
      ...(tab.asleep ? { asleep: true as const } : { ptyId: tab.id, seq: tab.client.seq }),
    };
  });
  return next ? { layout: next, tabs } : null;
}

/**
 * The snapshot's layout with the ids of the tabs that came back: `ids` maps a snapshot id to its new
 * one. A tab that did not come back (a skipped shell, a file that is gone) leaves its pane; the review
 * and file tabs not in `ids` keep their own id when `keep` says so. Null when no tab is left.
 */
export function fromSnapshot(saved: PaneLayout, ids: ReadonlyMap<string, string>, keep: (id: string) => boolean): PaneLayout | null {
  const layout = withOptional(saved);
  const all = leaves(layout).flatMap((n) => (n.kind === "leaf" ? n.tabs : []));
  let next: PaneLayout | null = layout;
  for (const id of all) {
    const to = ids.get(id);
    if (to !== undefined) next = next && replaceTab(next, id, to);
    else if (!(isPlace(id) && keep(id))) next = next && removeTab(next, id);
  }
  return next;
}

/**
 * The optional parts of a saved layout (`preset`, `canvas`) read with care: a layout saved before they
 * existed has neither, and a damaged one loses only the part that is wrong.
 */
export function withOptional(saved: PaneLayout): PaneLayout {
  const { preset, canvas, ...base } = saved as PaneLayout & { preset?: unknown; canvas?: unknown };
  const c = readCanvas(canvas);
  return { ...base, ...(isLayoutPreset(preset) ? { preset } : {}), ...(c ? { canvas: c } : {}) };
}
