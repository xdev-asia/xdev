import { expect, it } from "vitest";
import { initialCanvas } from "./canvas/canvasModel";
import { fromSnapshot, toSnapshot } from "./layoutSnapshot";
import { applyPreset, presetTree } from "./layoutPresets";
import { leaves, type PaneLayout } from "./paneTree";
import { paneRects } from "./PaneView";

// File tabs need no live terminal, so a layout of them goes through the snapshot on its own.
const files = ["file:a.ts", "file:b.ts", "file:c.ts"];
const base = (): PaneLayout => {
  const root = presetTree("columns", files, files[0]);
  return { root, focused: leaves({ root, focused: "", expanded: null })[0].id, expanded: null };
};
const keepAll = () => true;
const roundTrip = (l: PaneLayout): PaneLayout | null => {
  const snap = toSnapshot(l, () => null);
  const json = JSON.parse(JSON.stringify(snap)) as NonNullable<typeof snap>;
  return fromSnapshot(json.layout, new Map(), keepAll);
};

it("an old saved layout (no preset, no canvas) still loads, unchanged", () => {
  const old = base();
  const raw = JSON.parse(JSON.stringify(old)) as PaneLayout;
  expect("preset" in raw).toBe(false);
  const back = fromSnapshot(raw, new Map(), keepAll);
  expect(back).toEqual(old);
  expect(back && "preset" in back).toBe(false);
  expect(back && "canvas" in back).toBe(false);
});

it("the preset and the canvas survive a save and restore", () => {
  const arranged = applyPreset(base(), "grid");
  const canvas = initialCanvas(paneRects(arranged));
  const moved = { ...canvas, zoom: 0.75, cards: { ...canvas.cards, p1: { ...canvas.cards.p1, x: 123, y: 45 } } };
  const back = roundTrip({ ...arranged, canvas: moved });
  expect(back?.preset).toBe("grid");
  expect(back?.canvas).toEqual(moved);
});

it("a damaged preset or canvas is dropped and the tree still loads", () => {
  const raw = { ...base(), preset: "nonsense", canvas: "oops" } as unknown as PaneLayout;
  const back = fromSnapshot(raw, new Map(), keepAll);
  expect(back).not.toBeNull();
  expect(back && "preset" in back).toBe(false);
  expect(back && "canvas" in back).toBe(false);
});
