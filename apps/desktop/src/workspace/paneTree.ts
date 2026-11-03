// Pane tree for one worktree's terminal area.
// Contract only: Lane U1 (feat/pane-tree) replaces these stubs with the real pure functions.
// Every function returns a new object only when something changed, the same reference otherwise.

export type PaneDir = "right" | "down";

export type PaneNode =
  | { kind: "leaf"; id: string; tabs: string[]; active: string }
  | { kind: "split"; id: string; dir: PaneDir; children: PaneNode[]; sizes: number[] };

export interface PaneLayout {
  root: PaneNode;
  /** Id of the focused leaf. */
  focused: string;
  expanded: string | null;
}

export function single(tabId: string): PaneLayout {
  const id = "p1";
  return { root: { kind: "leaf", id, tabs: [tabId], active: tabId }, focused: id, expanded: null };
}

/** Adds the tab to the focused pane by default. */
export function addTab(l: PaneLayout, _tabId: string, _pane?: string): PaneLayout {
  return l;
}

/** Returns null when nothing is left. */
export function removeTab(l: PaneLayout, _tabId: string): PaneLayout | null {
  return l;
}

export function splitPane(l: PaneLayout, _pane: string, _dir: PaneDir, _tabId: string): PaneLayout {
  return l;
}

export function closePane(l: PaneLayout, _pane: string): PaneLayout | null {
  return l;
}

export function focusPane(l: PaneLayout, _pane: string): PaneLayout {
  return l;
}

/** Next or previous leaf in reading order; wraps. */
export function neighbour(l: PaneLayout, _from: string, _step: 1 | -1): string {
  return l.focused;
}

export function toggleExpand(l: PaneLayout, _pane: string): PaneLayout {
  return l;
}

export function equalize(l: PaneLayout): PaneLayout {
  return l;
}

export function resize(l: PaneLayout, _splitId: string, _sizes: number[]): PaneLayout {
  return l;
}

/** Selects the tab and focuses its pane. */
export function selectTab(l: PaneLayout, _tabId: string): PaneLayout {
  return l;
}

/** Leaves in reading order. */
export function leaves(l: PaneLayout): PaneNode[] {
  return l.root.kind === "leaf" ? [l.root] : [];
}

export function paneOf(l: PaneLayout, tabId: string): string | null {
  return l.root.kind === "leaf" && l.root.tabs.includes(tabId) ? l.root.id : null;
}
