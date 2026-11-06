// Pane tree for one worktree's terminal area.
// Pure functions. Each returns a new object only when something changed, the same reference otherwise,
// so `useSyncExternalStore` snapshots stay stable.

import type { CanvasState } from "./canvas/canvasModel";
import type { LayoutPreset } from "./layoutPresets";

export type PaneDir = "right" | "down";

export type PaneNode =
  | { kind: "leaf"; id: string; tabs: string[]; active: string }
  | { kind: "split"; id: string; dir: PaneDir; children: PaneNode[]; sizes: number[] };

export interface PaneLayout {
  root: PaneNode;
  /** Id of the focused leaf. */
  focused: string;
  expanded: string | null;
  /** The preset the panes were last arranged by, while the arrangement still holds. Absent in older layouts. */
  preset?: LayoutPreset;
  /** The terminal canvas: card positions and view. The tree above stays as it was while it is on. Absent in older layouts. */
  canvas?: CanvasState;
}

type Leaf = Extract<PaneNode, { kind: "leaf" }>;
type Split = Extract<PaneNode, { kind: "split" }>;

const MIN_SIZE = 0.1;
/** The review and commit tabs live in a pane's strip but are never the seed of a new pane. */
const REVIEW_PREFIX = "review:";
const COMMIT_PREFIX = "commit:";

export function single(tabId: string): PaneLayout {
  const id = "p1";
  return { root: { kind: "leaf", id, tabs: [tabId], active: tabId }, focused: id, expanded: null };
}

// ---- helpers -------------------------------------------------------------------------------

function allNodes(n: PaneNode, out: PaneNode[] = []): PaneNode[] {
  out.push(n);
  if (n.kind === "split") for (const c of n.children) allNodes(c, out);
  return out;
}

function freshId(l: PaneLayout, prefix: "p" | "s"): string {
  let max = 0;
  for (const n of allNodes(l.root)) {
    if (n.id.startsWith(prefix)) max = Math.max(max, Number(n.id.slice(1)) || 0);
  }
  return `${prefix}${max + 1}`;
}

function findLeaf(l: PaneLayout, pane: string): Leaf | null {
  const n = allNodes(l.root).find((x) => x.kind === "leaf" && x.id === pane);
  return (n as Leaf | undefined) ?? null;
}

/** Rebuilds the tree bottom-up with `fn` applied to the node `id`. Same reference when `fn` returns it unchanged. */
function mapNode(n: PaneNode, id: string, fn: (n: PaneNode) => PaneNode | null): PaneNode | null {
  if (n.id === id) return fn(n);
  if (n.kind === "leaf") return n;
  let changed = false;
  const kids: PaneNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const r = mapNode(c, id, fn);
    if (r !== c) changed = true;
    if (r) {
      kids.push(r);
      sizes.push(n.sizes[i]);
    }
  });
  if (!changed) return n;
  return normalize({ ...n, children: kids, sizes });
}

function renormalize(sizes: number[]): number[] {
  const sum = sizes.reduce((s, x) => s + x, 0) || 1;
  return sizes.map((x) => x / sum);
}

/** Collapses single-child splits, flattens same-direction nesting, renormalises sizes. */
function normalize(n: Split): PaneNode | null {
  if (n.children.length === 0) return null;
  if (n.children.length === 1) return n.children[0];
  const kids: PaneNode[] = [];
  const sizes: number[] = [];
  const total = n.sizes.reduce((s, x) => s + x, 0) || 1;
  n.children.forEach((c, i) => {
    const share = n.sizes[i] / total;
    if (c.kind === "split" && c.dir === n.dir) {
      c.children.forEach((g, j) => {
        kids.push(g);
        sizes.push(share * c.sizes[j]);
      });
    } else {
      kids.push(c);
      sizes.push(share);
    }
  });
  return { ...n, children: kids, sizes: renormalize(sizes) };
}

function withTree(l: PaneLayout, root: PaneNode | null, prefer?: string): PaneLayout | null {
  if (!root) return null;
  const ls = allNodes(root).filter((n): n is Leaf => n.kind === "leaf");
  const has = (id: string | null) => !!id && ls.some((n) => n.id === id);
  const focused = has(prefer ?? l.focused) ? (prefer ?? l.focused) : ls[0].id;
  let expanded = l.expanded;
  if (ls.length < 2 || !has(expanded)) expanded = null;
  // A preset describes the arrangement it made; once panes come or go it no longer does.
  const kept = ls.length === leaves(l).length ? l : noPreset(l);
  return { ...kept, root, focused, expanded };
}

/** The layout without its preset: a change to the arrangement means the preset no longer describes it. */
function noPreset(l: PaneLayout): PaneLayout {
  if (l.preset === undefined) return l;
  const copy = { ...l };
  delete copy.preset;
  return copy;
}

// ---- queries -------------------------------------------------------------------------------

/** Leaves in reading order. */
export function leaves(l: PaneLayout): PaneNode[] {
  return allNodes(l.root).filter((n) => n.kind === "leaf");
}

export function paneOf(l: PaneLayout, tabId: string): string | null {
  const n = leaves(l).find((x) => x.kind === "leaf" && x.tabs.includes(tabId));
  return n ? n.id : null;
}

/** Next or previous leaf in reading order; wraps. */
export function neighbour(l: PaneLayout, from: string, step: 1 | -1): string {
  const ids = leaves(l).map((n) => n.id);
  const i = ids.indexOf(from);
  if (i < 0) return l.focused;
  return ids[(i + step + ids.length) % ids.length];
}

// ---- tabs ----------------------------------------------------------------------------------

/**
 * Adds the tab to the focused pane by default and makes it the pane's active tab; `activate: false`
 * adds it behind the active one. A tab already in the layout is left alone.
 */
export function addTab(l: PaneLayout, tabId: string, pane?: string, opts: { activate?: boolean } = {}): PaneLayout {
  if (paneOf(l, tabId)) return l;
  const target = pane ?? l.focused;
  if (!findLeaf(l, target)) return l;
  const root = mapNode(l.root, target, (n) =>
    n.kind === "leaf" ? { ...n, tabs: [...n.tabs, tabId], active: opts.activate === false ? n.active : tabId } : n,
  )!;
  return { ...l, root };
}

/** Returns null when nothing is left. */
export function removeTab(l: PaneLayout, tabId: string): PaneLayout | null {
  const pane = paneOf(l, tabId);
  if (!pane) return l;
  const root = mapNode(l.root, pane, (n) => {
    if (n.kind !== "leaf") return n;
    const i = n.tabs.indexOf(tabId);
    const tabs = n.tabs.filter((t) => t !== tabId);
    if (!tabs.length) return null;
    const active = n.active === tabId ? tabs[Math.min(i, tabs.length - 1)] : n.active;
    return { ...n, tabs, active };
  });
  return withTree(l, root);
}

export function selectTab(l: PaneLayout, tabId: string): PaneLayout {
  const pane = paneOf(l, tabId);
  if (!pane) return l;
  const leaf = findLeaf(l, pane)!;
  let next = l;
  if (leaf.active !== tabId) {
    next = { ...next, root: mapNode(next.root, pane, (n) => (n.kind === "leaf" ? { ...n, active: tabId } : n))! };
  }
  return focusPane(next, pane);
}

// ---- panes ---------------------------------------------------------------------------------

/** `before` puts the new pane first (left of / above `pane`) instead of after it. */
export function splitPane(l: PaneLayout, pane: string, dir: PaneDir, tabId: string, before = false): PaneLayout {
  if (!findLeaf(l, pane) || paneOf(l, tabId) || tabId.startsWith(REVIEW_PREFIX) || tabId.startsWith(COMMIT_PREFIX)) return l;
  const newId = freshId(l, "p");
  const splitId = freshId(l, "s");
  const fresh: Leaf = { kind: "leaf", id: newId, tabs: [tabId], active: tabId };
  const root = mapNode(l.root, pane, (n) =>
    normalize({ kind: "split", id: splitId, dir, children: before ? [fresh, n] : [n, fresh], sizes: [0.5, 0.5] }),
  )!;
  return { ...noPreset(l), root, focused: newId, expanded: null };
}

export type PaneEdge = "left" | "right" | "top" | "bottom";

/**
 * Moves the whole pane `source` (with its tabs) next to the pane `target`, on `edge` of it, and focuses it.
 * The split the source leaves is collapsed. Same reference when nothing can move: either id is not a
 * pane, or the source is dropped on itself.
 */
export function movePane(l: PaneLayout, source: string, target: string, edge: PaneEdge): PaneLayout {
  if (source === target) return l;
  const moving = findLeaf(l, source);
  if (!moving || !findLeaf(l, target)) return l;
  const rest = mapNode(l.root, source, () => null);
  if (!rest) return l;
  const splitId = freshId(l, "s");
  const before = edge === "left" || edge === "top";
  const dir: PaneDir = edge === "left" || edge === "right" ? "right" : "down";
  const root = mapNode(rest, target, (n) =>
    normalize({ kind: "split", id: splitId, dir, children: before ? [moving, n] : [n, moving], sizes: [0.5, 0.5] }),
  )!;
  return { ...noPreset(l), root, focused: source, expanded: null };
}

export function closePane(l: PaneLayout, pane: string): PaneLayout | null {
  if (!findLeaf(l, pane)) return l;
  return withTree(l, mapNode(l.root, pane, () => null));
}

export function focusPane(l: PaneLayout, pane: string): PaneLayout {
  if (!findLeaf(l, pane)) return l;
  // While expanded, focus never lands on a hidden pane: the expansion follows (R4).
  const expanded = l.expanded !== null ? pane : null;
  if (l.focused === pane && l.expanded === expanded) return l;
  return { ...l, focused: pane, expanded };
}

export function toggleExpand(l: PaneLayout, pane: string): PaneLayout {
  if (!findLeaf(l, pane)) return l;
  if (l.expanded === pane) return { ...l, expanded: null };
  if (leaves(l).length < 2) return l;
  return { ...l, focused: pane, expanded: pane };
}

// ---- sizes ---------------------------------------------------------------------------------

function clampSizes(sizes: number[]): number[] {
  const n = sizes.length;
  const floor = Math.min(MIN_SIZE, 1 / n);
  let s = renormalize(sizes.map((x) => Math.max(0, x)));
  // Raise the small ones to the floor and take the difference from the rest, proportionally.
  for (let pass = 0; pass < n; pass++) {
    const low = s.map((x) => x < floor);
    if (!low.some(Boolean)) break;
    const fixed = low.filter(Boolean).length * floor;
    const restSum = s.reduce((a, x, i) => a + (low[i] ? 0 : x), 0) || 1;
    s = s.map((x, i) => (low[i] ? floor : (x / restSum) * (1 - fixed)));
  }
  return s;
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

export function resize(l: PaneLayout, splitId: string, sizes: number[]): PaneLayout {
  const node = allNodes(l.root).find((n) => n.kind === "split" && n.id === splitId) as Split | undefined;
  if (!node || sizes.length !== node.children.length) return l;
  const next = clampSizes(sizes);
  if (same(next, node.sizes)) return l;
  return { ...l, root: mapNode(l.root, splitId, (n) => (n.kind === "split" ? { ...n, sizes: next } : n))! };
}

function equalNode(n: PaneNode): PaneNode {
  if (n.kind === "leaf") return n;
  const kids = n.children.map(equalNode);
  const sizes = kids.map(() => 1 / kids.length);
  const unchanged = kids.every((k, i) => k === n.children[i]) && same(sizes, n.sizes);
  return unchanged ? n : { ...n, children: kids, sizes };
}

export function equalize(l: PaneLayout): PaneLayout {
  const root = equalNode(l.root);
  return root === l.root ? l : { ...l, root };
}

/** Swaps a tab id for another in place (a restarted terminal keeps its position). */
export function replaceTab(l: PaneLayout, oldId: string, newId: string): PaneLayout {
  const pane = paneOf(l, oldId);
  if (!pane || oldId === newId) return l;
  const root = mapNode(l.root, pane, (n) =>
    n.kind === "leaf"
      ? { ...n, tabs: n.tabs.map((t) => (t === oldId ? newId : t)), active: n.active === oldId ? newId : n.active }
      : n,
  )!;
  return { ...l, root };
}

/** Puts the pinned tabs of `pane` first, each group keeping its order. Same reference when the order holds. */
export function pinFirst(l: PaneLayout, pane: string, pinned: (tabId: string) => boolean): PaneLayout {
  const leaf = findLeaf(l, pane);
  if (!leaf) return l;
  const tabs = [...leaf.tabs.filter(pinned), ...leaf.tabs.filter((t) => !pinned(t))];
  if (tabs.every((t, i) => t === leaf.tabs[i])) return l;
  const root = mapNode(l.root, pane, (n) => (n.kind === "leaf" ? { ...n, tabs } : n))!;
  return { ...l, root };
}

/** Replaces the tab order of `pane` (same set of ids). Same reference when the order holds. */
export function setPaneTabs(l: PaneLayout, pane: string, tabs: string[]): PaneLayout {
  const leaf = findLeaf(l, pane);
  if (!leaf || tabs.length !== leaf.tabs.length || tabs.every((t, i) => t === leaf.tabs[i])) return l;
  if (!tabs.every((t) => leaf.tabs.includes(t))) return l;
  const root = mapNode(l.root, pane, (n) => (n.kind === "leaf" ? { ...n, tabs } : n))!;
  return { ...l, root };
}
