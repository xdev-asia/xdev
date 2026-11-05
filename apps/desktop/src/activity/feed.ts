import type { Sessions, Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";

/** The most entries the feed keeps. */
export const FEED_CAP = 200;

/** One status change of an agent tab. */
export interface FeedEntry {
  /** Counts up for the life of the feed; a stable key. */
  id: number;
  tabId: string;
  worktree: string;
  profileId: string;
  /** The title of the tab when it happened (null when it has none). */
  title: string | null;
  from: TabStatus;
  to: TabStatus;
  /** When it happened, in ms. */
  at: number;
}

/**
 * What the agent tabs did, newest first. It starts when the workspace opens and is not saved. The
 * snapshot is the same array until an entry is added, so a view can read it with a subscription.
 */
export class ActivityFeed {
  private list: readonly FeedEntry[] = [];
  private next = 1;
  // The entries of the latest clear, kept once so it can be undone; `undo` counts the clears.
  private cleared: { token: number; entries: readonly FeedEntry[] } | null = null;
  private undo = 0;
  private readonly listeners = new Set<() => void>();

  snapshot(): readonly FeedEntry[] {
    return this.list;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a change; a done that goes back to idle is noise after the done and is left out. */
  record(tab: Pick<Tab, "id" | "worktree" | "profileId" | "title">, from: TabStatus, to: TabStatus, at: number): void {
    if (from === "done" && to === "idle") return;
    const entry: FeedEntry = { id: this.next++, tabId: tab.id, worktree: tab.worktree, profileId: tab.profileId, title: tab.title ?? null, from, to, at };
    this.list = [entry, ...this.list].slice(0, FEED_CAP);
    this.emit();
  }

  /** Empties the feed and returns a token for `restore`; 0 when there was nothing to clear. */
  clear(): number {
    if (this.list.length === 0) return 0;
    const token = ++this.undo;
    this.cleared = { token, entries: this.list };
    this.list = [];
    this.emit();
    return token;
  }

  /**
   * Puts back what the clear that gave `token` removed, after any newer entries, still within FEED_CAP.
   * False when a newer clear happened or the token was used.
   */
  restore(token: number): boolean {
    if (!this.cleared || this.cleared.token !== token) return false;
    this.list = [...this.list, ...this.cleared.entries].slice(0, FEED_CAP);
    this.cleared = null;
    this.emit();
    return true;
  }

  /** Records what `sessions` reports; returns the stop. */
  follow(sessions: Pick<Sessions, "onStatus">): () => void {
    return sessions.onStatus((tab, from, to, at) => this.record(tab, from, to, at));
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
