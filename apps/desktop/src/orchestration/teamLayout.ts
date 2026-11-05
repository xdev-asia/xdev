/** A deterministic layout of tabs (nodes) and links (directed edges): layered by link depth, no physics. */

export interface MapInput {
  id: string;
  label: string;
}

export interface MapLink {
  from: string;
  to: string;
  transcript: boolean;
  screen: boolean;
}

export interface MapNode extends MapInput {
  /** The column: the longest chain of links that leads to the node. */
  layer: number;
  /** The row within the column. */
  index: number;
  x: number;
  y: number;
}

export interface MapEdge extends MapLink {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TeamLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
}

export const NODE_W = 140;
export const NODE_H = 40;
const COL = 220;
const ROW = 72;
const PAD = 16;

/**
 * Layers by the longest path from a tab no link points at. A cycle is cut where the walk meets a tab already on its
 * path, so every tab lands in a layer. Within a layer tabs go by label, then id, so the same input draws the same map.
 * Links to tabs that are not in `nodes` are dropped.
 */
export function layoutTeam(nodes: readonly MapInput[], links: readonly MapLink[]): TeamLayout {
  const ids = new Set(nodes.map((n) => n.id));
  const kept = links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  const into = new Map<string, string[]>();
  for (const l of kept) into.set(l.to, [...(into.get(l.to) ?? []), l.from]);
  const depth = new Map<string, number>();
  const walk = (id: string, path: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    path.add(id);
    let d = 0;
    for (const from of into.get(id) ?? []) {
      if (path.has(from)) continue;
      d = Math.max(d, walk(from, path) + 1);
    }
    path.delete(id);
    depth.set(id, d);
    return d;
  };
  const sorted = [...nodes].sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of sorted) walk(n.id, new Set());
  const rows = new Map<number, number>();
  const placed: MapNode[] = sorted
    .map((n) => ({ n, layer: depth.get(n.id) ?? 0 }))
    .sort((a, b) => a.layer - b.layer)
    .map(({ n, layer }) => {
      const index = rows.get(layer) ?? 0;
      rows.set(layer, index + 1);
      return { ...n, layer, index, x: PAD + layer * COL, y: PAD + index * ROW };
    });
  const at = new Map(placed.map((n) => [n.id, n]));
  const edges: MapEdge[] = kept.map((l) => {
    const a = at.get(l.from)!;
    const b = at.get(l.to)!;
    const forward = b.x > a.x;
    return {
      ...l,
      x1: forward ? a.x + NODE_W : a.x + NODE_W / 2,
      y1: forward ? a.y + NODE_H / 2 : a.y + NODE_H,
      x2: forward ? b.x : b.x + NODE_W / 2,
      y2: forward ? b.y + NODE_H / 2 : b.y,
    };
  });
  const layers = Math.max(1, ...placed.map((n) => n.layer + 1));
  const tallest = Math.max(1, ...rows.values());
  return { nodes: placed, edges, width: PAD * 2 + (layers - 1) * COL + NODE_W, height: PAD * 2 + (tallest - 1) * ROW + NODE_H };
}

/**
 * The node an arrow key, Home or End moves to from `id`. Up and down change row within the layer. Left and right change
 * layer, to a tab linked with this one when there is one (left: one that reads it, right: one it reads), else to the
 * nearest row.
 */
export function neighbour(layout: TeamLayout, id: string, key: string): string | null {
  const nodes = layout.nodes;
  if (nodes.length === 0) return null;
  if (key === "Home") return nodes[0].id;
  if (key === "End") return nodes[nodes.length - 1].id;
  const me = nodes.find((n) => n.id === id);
  if (!me) return nodes[0].id;
  const inLayer = (layer: number) => nodes.filter((n) => n.layer === layer);
  if (key === "ArrowUp" || key === "ArrowDown") {
    const col = inLayer(me.layer);
    const next = col[me.index + (key === "ArrowDown" ? 1 : -1)];
    return next ? next.id : me.id;
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const right = key === "ArrowRight";
    const col = inLayer(me.layer + (right ? 1 : -1));
    if (col.length === 0) return me.id;
    const linked = col.filter((n) => layout.edges.some((e) => (right ? e.from === me.id && e.to === n.id : e.from === n.id && e.to === me.id)));
    const pool = linked.length > 0 ? linked : col;
    const nearest = pool.reduce((best, n) => (Math.abs(n.y - me.y) < Math.abs(best.y - me.y) ? n : best));
    return nearest.id;
  }
  return null;
}

/** The words on an edge: the grants that are on, or `none`. */
export function grantWords(l: Pick<MapLink, "transcript" | "screen">): ("transcript" | "screen")[] {
  return [...(l.transcript ? (["transcript"] as const) : []), ...(l.screen ? (["screen"] as const) : [])];
}
