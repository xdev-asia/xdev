// Terminal canvas: the panes of a worktree as cards on a pannable, zoomable surface.
// Pure functions. Card positions are in world units (px at zoom 1); the view maps a world point to the
// screen as `world * zoom + (x, y)`. The pane tree is not touched, so leaving the canvas returns to it.

import { clampZoom, zoomAt } from "@xdev-asia/ui";

export interface CanvasCard {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasState {
  /** Canvas mode is on for this worktree. */
  on: boolean;
  zoom: number;
  /** Where the world origin sits inside the surface, in screen px. */
  x: number;
  y: number;
  /** Key: the pane id. */
  cards: Record<string, CanvasCard>;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 1.5;
export const ZOOM_STEP = 1.25;
/** The size the pane tree is spread over when the canvas first opens. */
export const WORLD = { w: 1600, h: 1000 };
export const MIN_CARD = { w: 240, h: 160 };
/** Space kept around the cards by Fit, and the pan of one arrow key press, in screen px. */
export const FIT_PADDING = 24;
export const PAN_STEP = 48;
export const NUDGE_STEP = 16;

export type CanvasAction =
  | { type: "move"; id: string; dx: number; dy: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number; at: { x: number; y: number } }
  | { type: "fit"; viewport: { w: number; h: number } }
  | { type: "reset" }
  | { type: "sync"; ids: string[] };

const round = (n: number) => Math.round(n * 100) / 100;

/** Cards for the panes in `rects` (fractions of the area), spread over `WORLD`, with a small gap between them. */
export function cardsFromRects(rects: Record<string, { x: number; y: number; w: number; h: number }>): Record<string, CanvasCard> {
  const gap = 8;
  const out: Record<string, CanvasCard> = {};
  for (const [id, r] of Object.entries(rects)) {
    out[id] = {
      x: round(r.x * WORLD.w + gap / 2),
      y: round(r.y * WORLD.h + gap / 2),
      w: Math.max(MIN_CARD.w, round(r.w * WORLD.w - gap)),
      h: Math.max(MIN_CARD.h, round(r.h * WORLD.h - gap)),
    };
  }
  return out;
}

export function initialCanvas(rects: Record<string, { x: number; y: number; w: number; h: number }>): CanvasState {
  return { on: true, zoom: 1, x: 0, y: 0, cards: cardsFromRects(rects) };
}

/** The screen rectangle of a card under the view. */
export function screenRect(s: Pick<CanvasState, "zoom" | "x" | "y">, c: CanvasCard): CanvasCard {
  return { x: c.x * s.zoom + s.x, y: c.y * s.zoom + s.y, w: c.w * s.zoom, h: c.h * s.zoom };
}

/** The box around every card, in world units; null with no card. */
export function bounds(cards: Record<string, CanvasCard>): CanvasCard | null {
  const all = Object.values(cards);
  if (all.length === 0) return null;
  const x = Math.min(...all.map((c) => c.x));
  const y = Math.min(...all.map((c) => c.y));
  return { x, y, w: Math.max(...all.map((c) => c.x + c.w)) - x, h: Math.max(...all.map((c) => c.y + c.h)) - y };
}

/** Zoom and pan that show every card inside `viewport`, centred; the zoom is clamped to the range. */
export function fit(s: CanvasState, viewport: { w: number; h: number }): CanvasState {
  const b = bounds(s.cards);
  if (!b || viewport.w <= 0 || viewport.h <= 0) return s;
  const zoom = clampZoom(Math.min((viewport.w - FIT_PADDING * 2) / b.w, (viewport.h - FIT_PADDING * 2) / b.h), MIN_ZOOM, MAX_ZOOM);
  return {
    ...s,
    zoom: round(zoom * 1000) / 1000,
    x: round((viewport.w - b.w * zoom) / 2 - b.x * zoom),
    y: round((viewport.h - b.h * zoom) / 2 - b.y * zoom),
  };
}

/** Adds a card (cascaded) for each pane that has none and drops the cards of panes that are gone. */
export function sync(s: CanvasState, ids: string[]): CanvasState {
  const keep = new Set(ids);
  const stale = Object.keys(s.cards).filter((id) => !keep.has(id));
  const fresh = ids.filter((id) => !s.cards[id]);
  if (stale.length === 0 && fresh.length === 0) return s;
  const cards: Record<string, CanvasCard> = {};
  for (const id of ids) if (s.cards[id]) cards[id] = s.cards[id];
  const b = bounds(cards);
  fresh.forEach((id, i) => {
    const at = b ? { x: b.x + 32 * (i + 1), y: b.y + 32 * (i + 1) } : { x: 32 * (i + 1), y: 32 * (i + 1) };
    cards[id] = { ...at, w: 640, h: 400 };
  });
  return { ...s, cards };
}

export function canvasReduce(s: CanvasState, a: CanvasAction): CanvasState {
  switch (a.type) {
    case "move": {
      const c = s.cards[a.id];
      if (!c || (a.dx === 0 && a.dy === 0)) return s;
      return { ...s, cards: { ...s.cards, [a.id]: { ...c, x: round(c.x + a.dx), y: round(c.y + a.dy) } } };
    }
    case "pan":
      return a.dx === 0 && a.dy === 0 ? s : { ...s, x: round(s.x + a.dx), y: round(s.y + a.dy) };
    case "zoom": {
      const z = zoomAt({ zoom: s.zoom, x: s.x, y: s.y }, a.at, a.factor, MIN_ZOOM, MAX_ZOOM);
      return z.zoom === s.zoom ? s : { ...s, zoom: round(z.zoom * 1000) / 1000, x: round(z.x), y: round(z.y) };
    }
    case "fit":
      return fit(s, a.viewport);
    case "reset":
      return s.zoom === 1 && s.x === 0 && s.y === 0 ? s : { ...s, zoom: 1, x: 0, y: 0 };
    case "sync":
      return sync(s, a.ids);
  }
}

/** A saved canvas read back: unknown or broken parts are dropped, so an old or damaged file still loads. */
export function readCanvas(raw: unknown): CanvasState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const cards: Record<string, CanvasCard> = {};
  if (typeof r.cards === "object" && r.cards !== null) {
    for (const [id, v] of Object.entries(r.cards as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const c = v as Record<string, unknown>;
      if (![c.x, c.y, c.w, c.h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      cards[id] = { x: c.x as number, y: c.y as number, w: Math.max(MIN_CARD.w, c.w as number), h: Math.max(MIN_CARD.h, c.h as number) };
    }
  }
  return { on: r.on === true, zoom: clampZoom(num(r.zoom, 1), MIN_ZOOM, MAX_ZOOM), x: num(r.x, 0), y: num(r.y, 0), cards };
}
