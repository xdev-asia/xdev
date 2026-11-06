import { expect, it } from "vitest";
import { bounds, canvasReduce, fit, initialCanvas, MAX_ZOOM, MIN_ZOOM, readCanvas, screenRect, sync, type CanvasState } from "./canvasModel";

const base: CanvasState = {
  on: true,
  zoom: 1,
  x: 0,
  y: 0,
  cards: { a: { x: 0, y: 0, w: 400, h: 300 }, b: { x: 500, y: 100, w: 400, h: 300 } },
};

it("move shifts one card by world units and leaves the rest; a no-op keeps the reference", () => {
  const n = canvasReduce(base, { type: "move", id: "a", dx: 10, dy: -5 });
  expect(n.cards.a).toMatchObject({ x: 10, y: -5 });
  expect(n.cards.b).toBe(base.cards.b);
  expect(canvasReduce(base, { type: "move", id: "a", dx: 0, dy: 0 })).toBe(base);
  expect(canvasReduce(base, { type: "move", id: "nope", dx: 5, dy: 5 })).toBe(base);
});

it("pan moves the view", () => {
  expect(canvasReduce(base, { type: "pan", dx: 30, dy: -20 })).toMatchObject({ x: 30, y: -20, zoom: 1 });
});

it("zoom is clamped to 50%-150% and keeps the point under the cursor", () => {
  let s = base;
  for (let i = 0; i < 20; i++) s = canvasReduce(s, { type: "zoom", factor: 1.25, at: { x: 100, y: 100 } });
  expect(s.zoom).toBe(MAX_ZOOM);
  for (let i = 0; i < 40; i++) s = canvasReduce(s, { type: "zoom", factor: 0.8, at: { x: 100, y: 100 } });
  expect(s.zoom).toBe(MIN_ZOOM);
  const z = canvasReduce({ ...base, x: 40, y: 20 }, { type: "zoom", factor: 1.25, at: { x: 200, y: 150 } });
  expect((200 - z.x) / z.zoom).toBeCloseTo(200 - 40, 1);
});

it("fit shows every card inside the viewport", () => {
  const vp = { w: 600, h: 400 };
  const s = canvasReduce(base, { type: "fit", viewport: vp });
  expect(s.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  expect(s.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  for (const c of Object.values(s.cards)) {
    const r = screenRect(s, c);
    expect(r.x).toBeGreaterThanOrEqual(-0.5);
    expect(r.y).toBeGreaterThanOrEqual(-0.5);
    expect(r.x + r.w).toBeLessThanOrEqual(vp.w + 0.5);
    expect(r.y + r.h).toBeLessThanOrEqual(vp.h + 0.5);
  }
  const empty = { ...base, cards: {} };
  expect(fit(empty, vp)).toBe(empty);
});

it("reset returns to 100% at the origin", () => {
  expect(canvasReduce({ ...base, zoom: 1.5, x: 9, y: 9 }, { type: "reset" })).toMatchObject({ zoom: 1, x: 0, y: 0 });
  expect(canvasReduce(base, { type: "reset" })).toBe(base);
});

it("sync adds cards for new panes, drops cards of gone panes, same reference when equal", () => {
  expect(sync(base, ["a", "b"])).toBe(base);
  const n = sync(base, ["b", "c"]);
  expect(Object.keys(n.cards).sort()).toEqual(["b", "c"]);
  expect(bounds(n.cards)).not.toBeNull();
});

it("initialCanvas spreads pane rects over the world", () => {
  const s = initialCanvas({ p1: { x: 0, y: 0, w: 0.5, h: 1 }, p2: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  expect(s.on).toBe(true);
  expect(s.cards.p2.x).toBeGreaterThan(s.cards.p1.x + s.cards.p1.w - 1);
});

it("readCanvas: broken input is dropped, zoom clamped, bad cards skipped", () => {
  expect(readCanvas(undefined)).toBeUndefined();
  expect(readCanvas("x")).toBeUndefined();
  const c = readCanvas({ on: true, zoom: 9, x: "no", cards: { a: { x: 1, y: 2, w: 500, h: 400 }, b: { x: "q" }, c: null } })!;
  expect(c).toMatchObject({ on: true, zoom: MAX_ZOOM, x: 0, y: 0 });
  expect(Object.keys(c.cards)).toEqual(["a"]);
});
