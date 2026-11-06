import { useSyncExternalStore } from "react";
import { addTab, focusPane, paneOf, selectTab, single, splitPane, type PaneLayout } from "@/workspace/paneTree";

// A browser tab of a worktree. Its id is `browser:<load>-<n>`, which no terminal, file, view,
// preview, review, commit or peer id can be. `<load>` differs on each page load, so an id is never
// used twice while the app runs: the backend skips a show of a tab it has closed. The entries live here; the worktree's layout holds the ids, so
// a saved layout keeps each tab's URL and a restart opens it again (`restoreBrowserTab`).
export const BROWSER_TAB = "browser:";
export const BLANK = "about:blank";

export interface BrowserTabEntry {
  id: string;
  worktree: string;
  /** The page address: what was last loaded, or what loads when the webview is made. */
  url: string;
  title: string | null;
  loading: boolean;
  /** Rises each time the tab is asked for, so the strip brings it to the front. 0: never asked. */
  seq: number;
  /** Rises each time `url` is set from outside the page (a link sent to the tab), so it loads it. */
  nav: number;
  /** Opens in a new pane to the right of the focused one rather than in it. */
  split: boolean;
  /** Comes to the front without taking the focus from the pane that has it. */
  keepFocus: boolean;
}

export function isBrowserTab(id: string): boolean {
  return id.startsWith(BROWSER_TAB);
}

let entries: readonly BrowserTabEntry[] = [];
let counter = 0;
let ids = 0;
const LOAD = Date.now().toString(36);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function update(id: string, change: (e: BrowserTabEntry) => BrowserTabEntry): void {
  let changed = false;
  entries = entries.map((e) => {
    if (e.id !== id) return e;
    const next = change(e);
    changed ||= next !== e;
    return next;
  });
  if (changed) emit();
}

export interface OpenBrowser {
  url?: string;
  split?: boolean;
  keepFocus?: boolean;
}

/** Opens a new browser tab in `worktree` and returns its id. */
export function openBrowserTab(worktree: string, how: OpenBrowser = {}): string {
  const id = `${BROWSER_TAB}${LOAD}-${++ids}`;
  entries = [
    ...entries,
    { id, worktree, url: how.url ?? BLANK, title: null, loading: false, seq: ++counter, nav: 0, split: how.split ?? false, keepFocus: how.keepFocus ?? false },
  ];
  emit();
  return id;
}

/** A tab of a saved layout: its URL loads when it is first shown; it does not come to the front. */
export function restoreBrowserTab(worktree: string, url: string, title: string | null = null): string {
  const id = `${BROWSER_TAB}${LOAD}-${++ids}`;
  entries = [...entries, { id, worktree, url: url || BLANK, title, loading: false, seq: 0, nav: 0, split: false, keepFocus: false }];
  emit();
  return id;
}

/** Loads `url` in a tab that is open and brings it to the front. */
export function sendToBrowserTab(id: string, url: string, keepFocus = false): void {
  const seq = ++counter;
  update(id, (e) => ({ ...e, url, nav: e.nav + 1, seq, keepFocus }));
}

/** Brings the tab to the front of its pane, and its pane into focus. */
export function frontBrowserTab(id: string): void {
  const seq = ++counter;
  update(id, (e) => ({ ...e, seq, keepFocus: false }));
}

/** What the page says about itself. A value that did not change emits nothing. */
export function notePage(id: string, page: { url?: string | null; title?: string | null; loading?: boolean | null }): void {
  update(id, (e) => {
    const url = page.url ?? e.url;
    const title = page.title === undefined || page.title === null ? e.title : page.title || null;
    const loading = page.loading ?? e.loading;
    return url === e.url && title === e.title && loading === e.loading ? e : { ...e, url, title, loading };
  });
}

export function closeBrowserTab(id: string): void {
  if (!entries.some((e) => e.id === id)) return;
  entries = entries.filter((e) => e.id !== id);
  emit();
}

export function browserTab(id: string): BrowserTabEntry | undefined {
  return entries.find((e) => e.id === id);
}

export function browserTabEntries(): readonly BrowserTabEntry[] {
  return entries;
}

/** The tab of `worktree` asked for last (or opened last), which a link reuses. */
export function latestBrowserTab(worktree: string): BrowserTabEntry | undefined {
  let best: BrowserTabEntry | undefined;
  for (const e of entries) if (e.worktree === worktree && (!best || e.seq >= best.seq)) best = e;
  return best;
}

export function subscribeBrowserTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useBrowserTabs(): readonly BrowserTabEntry[] {
  return useSyncExternalStore(subscribeBrowserTabs, browserTabEntries, browserTabEntries);
}

/** The layout with a browser tab that is not in it yet: beside the focused pane, or in it. */
export function placeBrowserTab(layout: PaneLayout | null, entry: Pick<BrowserTabEntry, "id" | "split" | "keepFocus">): PaneLayout {
  if (!layout) return single(entry.id);
  if (paneOf(layout, entry.id)) return layout;
  const from = layout.focused;
  if (!entry.split) return entry.keepFocus ? addTab(layout, entry.id, from) : addTab(layout, entry.id);
  const next = splitPane(layout, from, "right", entry.id);
  return entry.keepFocus ? focusPane(next, from) : next;
}

/** The layout with the tab at the front of its pane; the focus moves to it unless `keepFocus`. */
export function frontInLayout(layout: PaneLayout, id: string, keepFocus: boolean): PaneLayout {
  if (!paneOf(layout, id)) return layout;
  const next = selectTab(layout, id);
  return keepFocus ? focusPane(next, layout.focused) : next;
}

/** For tests. */
export function resetBrowserTabs(): void {
  entries = [];
  counter = 0;
  ids = 0;
  emit();
}
