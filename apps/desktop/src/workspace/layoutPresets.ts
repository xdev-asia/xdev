// Layout presets: named ways to arrange the panes of a worktree without closing or restarting a tab.
// Pure functions. A preset builder turns the tab ids and the active one into a pane tree; `applyPreset`
// puts that tree into a layout. Fullscreen is not a tree: it is the existing "expanded" pane, toggled.

import { leaves, toggleExpand, type PaneLayout, type PaneNode } from "./paneTree";

export type LayoutPreset = "grid" | "columns" | "rows" | "focus" | "fullscreen";

/** Every preset, in menu order. */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = ["grid", "columns", "rows", "focus", "fullscreen"];

export const isLayoutPreset = (v: unknown): v is LayoutPreset => typeof v === "string" && (LAYOUT_PRESETS as readonly string[]).includes(v);

type Leaf = Extract<PaneNode, { kind: "leaf" }>;
type Builder = (tabIds: string[], active: string) => PaneNode;

/** Share of the width the large pane takes in the focus preset. */
export const FOCUS_SHARE = 0.65;

/** These tabs live in a pane's strip but never seed a pane of their own (see `splitPane`). */
const isAttached = (id: string) => id.startsWith("review:") || id.startsWith("commit:") || id.startsWith("preview:");

/** A builder numbers its panes `p1…` and its splits `s1…`, in reading order. */
function maker() {
  let p = 0;
  let s = 0;
  return {
    leaf: (tab: string): Leaf => ({ kind: "leaf", id: `p${++p}`, tabs: [tab], active: tab }),
    split(dir: "right" | "down", children: PaneNode[], sizes?: number[]): PaneNode {
      if (children.length === 1) return children[0];
      return { kind: "split", id: `s${++s}`, dir, children, sizes: sizes ?? children.map(() => 1 / children.length) };
    },
  };
}

/** Columns and rows of the grid for `n` panes: as square as it gets, wider than tall. */
export function gridShape(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** The grid: a column of rows, each row a split of its panes. Ids follow reading order, outer split first. */
const grid: Builder = (tabIds) => {
  const { cols } = gridShape(tabIds.length);
  const lines: string[][] = [];
  for (let i = 0; i < tabIds.length; i += cols) lines.push(tabIds.slice(i, i + cols));
  let p = 0;
  let s = lines.length > 1 ? 1 : 0;
  const leaf = (tab: string): Leaf => ({ kind: "leaf", id: `p${++p}`, tabs: [tab], active: tab });
  const kids = lines.map((line): PaneNode => {
    const cells = line.map(leaf);
    if (cells.length === 1) return cells[0];
    return { kind: "split", id: `s${++s}`, dir: "right", children: cells, sizes: cells.map(() => 1 / cells.length) };
  });
  if (kids.length === 1) return kids[0];
  return { kind: "split", id: "s1", dir: "down", children: kids, sizes: kids.map(() => 1 / kids.length) };
};

const columns: Builder = (tabIds) => {
  const m = maker();
  return m.split("right", tabIds.map((t) => m.leaf(t)));
};

const rows: Builder = (tabIds) => {
  const m = maker();
  return m.split("down", tabIds.map((t) => m.leaf(t)));
};

const focus: Builder = (tabIds, active) => {
  const m = maker();
  const first = tabIds.includes(active) ? active : tabIds[0];
  const rest = tabIds.filter((t) => t !== first);
  if (rest.length === 0) return m.leaf(first);
  const big = m.leaf(first);
  const side = m.split("down", rest.map((t) => m.leaf(t)));
  return { kind: "split", id: `s${rest.length > 1 ? 2 : 1}`, dir: "right", children: [big, side], sizes: [FOCUS_SHARE, 1 - FOCUS_SHARE] };
};

const BUILDERS: Record<Exclude<LayoutPreset, "fullscreen">, Builder> = { grid, columns, rows, focus };

/**
 * The pane tree of a preset for these tabs, one pane each. Needs at least one tab. `fullscreen` has no tree
 * of its own: it returns the tabs as columns, which `applyPreset` does not use.
 */
export function presetTree(preset: LayoutPreset, tabIds: string[], active: string): PaneNode {
  return (preset === "fullscreen" ? columns : BUILDERS[preset])(tabIds, active);
}

/**
 * The layout with the panes rearranged. Every tab stays; tabs that cannot seed a pane (review, commit,
 * preview) join the pane of the active tab. The focused pane is the one of the active tab, and canvas mode
 * is left (its cards are kept). Fullscreen toggles the focused pane's expansion.
 * Same reference when there is nothing to arrange.
 */
export function applyPreset(layout: PaneLayout, preset: LayoutPreset): PaneLayout {
  const all = leaves(layout).flatMap((n) => (n.kind === "leaf" ? n.tabs : []));
  const focusedLeaf = leaves(layout).find((n) => n.kind === "leaf" && n.id === layout.focused);
  const active = focusedLeaf && focusedLeaf.kind === "leaf" ? focusedLeaf.active : (all[0] ?? "");
  if (preset === "fullscreen") {
    const next = toggleExpand(layout, layout.focused);
    return next === layout ? leaveCanvas(layout) : { ...leaveCanvas(next), preset: next.expanded ? "fullscreen" : layout.preset };
  }
  const seeds = all.filter((t) => !isAttached(t));
  if (seeds.length === 0) return layout;
  const attached = all.filter(isAttached);
  // The seed the active tab belongs to; an attached active tab belongs to the first seed.
  const home = seeds.includes(active) ? active : seeds[0];
  const root = presetTree(preset, seeds, home);
  const place = (n: PaneNode): PaneNode => {
    if (n.kind === "split") return { ...n, children: n.children.map(place) };
    if (n.tabs[0] !== home) return n;
    const tabs = [...n.tabs, ...attached];
    // The pane keeps the tab that was in front there; an attached tab in front stays in front.
    return { ...n, tabs, active: attached.includes(active) ? active : n.active };
  };
  const placed = place(root);
  const focused = (leaves({ ...layout, root: placed }).find((n) => n.kind === "leaf" && n.tabs.includes(active)) ?? leaves({ ...layout, root: placed })[0]).id;
  return { ...leaveCanvas(layout), root: placed, focused, expanded: null, preset };
}

/** A preset arranges the tree, so it also leaves canvas mode (the cards stay for the next visit). */
function leaveCanvas(l: PaneLayout): PaneLayout {
  return l.canvas?.on ? { ...l, canvas: { ...l.canvas, on: false } } : l;
}

/** Whether the preset would change anything for this layout (for a menu that disables the no-op). */
export function presetApplies(layout: PaneLayout, preset: LayoutPreset): boolean {
  if (preset === "fullscreen") return leaves(layout).length > 1 || layout.expanded !== null;
  return applyPreset(layout, preset) !== layout && leaves(layout).length > 0;
}
