import { equalize, focusPane, leaves, neighbour, removeTab, selectTab, splitPane, toggleExpand, type PaneDir, type PaneLayout, type PaneNode } from "./paneTree";

/**
 * What the pane actions need of `Sessions`: the layout of a worktree and a way to replace it.
 * Lane U1 adds both to `Sessions`; until then a `Sessions` without them has no panes, and every
 * action here does nothing.
 */
export interface LayoutHost {
  layout(worktree: string): PaneLayout | null;
  setLayout(worktree: string, next: PaneLayout | null): void;
}

export function hostOf(sessions: object): LayoutHost | null {
  const s = sessions as Partial<LayoutHost>;
  return typeof s.layout === "function" && typeof s.setLayout === "function" ? (s as LayoutHost) : null;
}

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

function focusedLeaf(l: PaneLayout): Leaf | null {
  const found = leaves(l).find((n) => n.id === l.focused);
  return found && found.kind === "leaf" ? found : null;
}

/** Tab ids of the focused pane, and the one in front there; null without a layout. */
export function focusedPane(host: LayoutHost | null, worktree: string): { tabs: string[]; active: string } | null {
  const l = host?.layout(worktree);
  const leaf = l ? focusedLeaf(l) : null;
  return leaf ? { tabs: leaf.tabs, active: leaf.active } : null;
}

/** Puts `id` in front in its pane and focuses that pane. Returns false without a layout. */
export function selectInLayout(host: LayoutHost | null, worktree: string, id: string): boolean {
  const l = host?.layout(worktree);
  if (!host || !l) return false;
  const next = selectTab(l, id);
  if (next !== l) host.setLayout(worktree, next);
  return true;
}

/**
 * Splits the focused pane. `openTab` starts the new tab (the default shell) and returns its id;
 * `Sessions.open` puts it in the focused pane, so it is taken out of there and given the new pane.
 * Returns false when the worktree has no layout (nothing to split) or no tab could start.
 */
export function splitFocused(host: LayoutHost | null, worktree: string, dir: PaneDir, openTab: () => string | null): boolean {
  const before = host?.layout(worktree);
  if (!host || !before) return false;
  const pane = before.focused;
  const id = openTab();
  if (id === null) return false;
  const after = host.layout(worktree) ?? before;
  const detached = leaves(after).some((n) => n.kind === "leaf" && n.tabs.includes(id)) ? (removeTab(after, id) ?? after) : after;
  host.setLayout(worktree, splitPane(detached, pane, dir, id));
  return true;
}

/**
 * Moves focus to the next or previous pane in reading order. While a pane is expanded the
 * expansion moves with the focus, so focus never lands on a hidden pane. Returns the tab in
 * front in the new pane (for the terminal to focus), or null when nothing moved.
 */
export function movePane(host: LayoutHost | null, worktree: string, step: 1 | -1): string | null {
  const l = host?.layout(worktree);
  if (!host || !l) return null;
  const to = neighbour(l, l.focused, step);
  if (to === l.focused && l.expanded === null) return null;
  let next = focusPane(l, to);
  if (l.expanded !== null && next.expanded !== to) next = { ...next, expanded: to };
  if (next !== l) host.setLayout(worktree, next);
  const leaf = leaves(next).find((n) => n.id === to);
  return leaf && leaf.kind === "leaf" ? leaf.active : null;
}

export function expandFocused(host: LayoutHost | null, worktree: string): boolean {
  const l = host?.layout(worktree);
  if (!host || !l) return false;
  host.setLayout(worktree, toggleExpand(l, l.focused));
  return true;
}

export function equalizeAll(host: LayoutHost | null, worktree: string): boolean {
  const l = host?.layout(worktree);
  if (!host || !l) return false;
  const next = equalize(l);
  if (next !== l) host.setLayout(worktree, next);
  return true;
}
