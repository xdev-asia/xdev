import { expect, it } from "vitest";
import { applyPreset, applyUserPreset, gridShape, LAYOUT_PRESETS, presetTree, readSaved, savedLayoutOf, type UserPreset } from "./layoutPresets";
import { leaves, type PaneLayout, type PaneNode } from "./paneTree";
import { paneRects } from "./PaneView";
import { initialCanvas } from "./canvas/canvasModel";

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const tabsOf = (root: PaneNode): string[] => (root.kind === "leaf" ? root.tabs : root.children.flatMap(tabsOf));
const leafList = (l: PaneLayout): Leaf[] => leaves(l).filter((n): n is Leaf => n.kind === "leaf");
const wrap = (root: PaneNode): PaneLayout => ({ root, focused: leafList({ root, focused: "", expanded: null })[0].id, expanded: null });
const layoutOf = (tabs: string[], focusIndex = 0): PaneLayout => {
  const l = wrap(presetTree("columns", tabs, tabs[0]));
  return { ...l, focused: leafList(l)[focusIndex].id };
};

for (const preset of ["grid", "columns", "rows", "focus"] as const) {
  it(`${preset}: one pane per tab, none lost, ids unique, sizes sum to 1, for 1 to 9 panes`, () => {
    for (let n = 1; n <= 9; n++) {
      const tabs = ids(n);
      const root = presetTree(preset, tabs, tabs[Math.min(1, n - 1)]);
      expect([...tabsOf(root)].sort()).toEqual([...tabs].sort());
      const all: string[] = [];
      const walk = (x: PaneNode) => {
        all.push(x.id);
        if (x.kind === "split") {
          expect(x.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
          x.children.forEach(walk);
        }
      };
      walk(root);
      expect(new Set(all).size).toBe(all.length);
    }
  });
}

it("gridShape: as square as it gets", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => gridShape(n))).toEqual([
    { cols: 1, rows: 1 },
    { cols: 2, rows: 1 },
    { cols: 2, rows: 2 },
    { cols: 2, rows: 2 },
    { cols: 3, rows: 2 },
    { cols: 3, rows: 2 },
    { cols: 3, rows: 3 },
    { cols: 3, rows: 3 },
    { cols: 3, rows: 3 },
  ]);
});

it("grid of 4 is 2x2: four equal quarters at four places", () => {
  const r = Object.values(paneRects(wrap(presetTree("grid", ids(4), "t1"))));
  expect(r).toHaveLength(4);
  for (const x of r) expect([x.w, x.h]).toEqual([0.5, 0.5]);
  expect(new Set(r.map((x) => `${x.x},${x.y}`)).size).toBe(4);
});

it("columns are side by side, rows are stacked", () => {
  const c = Object.values(paneRects(wrap(presetTree("columns", ids(3), "t1"))));
  expect(c.every((x) => x.h === 1 && x.y === 0)).toBe(true);
  const r = Object.values(paneRects(wrap(presetTree("rows", ids(3), "t1"))));
  expect(r.every((x) => x.w === 1 && x.x === 0)).toBe(true);
});

it("focus: the active tab is the large pane on the left, the rest stack on the right", () => {
  const l = wrap(presetTree("focus", ids(4), "t3"));
  const rects = paneRects(l);
  const ls = leafList(l);
  const big = ls.find((n) => n.tabs[0] === "t3")!;
  expect(rects[big.id]).toMatchObject({ x: 0, y: 0, h: 1 });
  expect(rects[big.id].w).toBeGreaterThan(0.5);
  const others = ls.filter((n) => n !== big);
  expect(others.map((n) => n.tabs[0])).toEqual(["t1", "t2", "t4"]);
  expect(others.every((n) => rects[n.id].x > 0.5)).toBe(true);
});

it("applyPreset keeps every tab, focuses the active tab's pane and records the preset", () => {
  const l = layoutOf(ids(5), 3);
  for (const preset of ["grid", "columns", "rows", "focus"] as const) {
    const next = applyPreset(l, preset);
    expect(next.preset).toBe(preset);
    expect([...tabsOf(next.root)].sort()).toEqual(ids(5));
    expect(leafList(next).find((n) => n.id === next.focused)?.tabs).toContain("t4");
  }
});

it("applyPreset: review tabs join the active pane and never seed one", () => {
  const l = wrap({ kind: "leaf", id: "p1", tabs: ["t1", "review:x", "t2"], active: "t1" });
  const next = applyPreset(l, "columns");
  expect(leafList(next)).toHaveLength(2);
  expect(leafList(next).find((n) => n.tabs.includes("t1"))?.tabs).toEqual(["t1", "review:x"]);
});

it("fullscreen toggles the focused pane and back; one pane has nothing to expand", () => {
  const l = layoutOf(ids(3), 1);
  const on = applyPreset(l, "fullscreen");
  expect(on.expanded).toBe(l.focused);
  expect(on.preset).toBe("fullscreen");
  expect(applyPreset(on, "fullscreen").expanded).toBeNull();
  const one = layoutOf(ids(1));
  expect(applyPreset(one, "fullscreen")).toBe(one);
  expect(LAYOUT_PRESETS).toContain("fullscreen");
});

it("a preset leaves canvas mode and keeps the cards", () => {
  const l = layoutOf(ids(2));
  const canvas = initialCanvas(paneRects(l));
  const next = applyPreset({ ...l, canvas }, "rows");
  expect(next.canvas?.on).toBe(false);
  expect(next.canvas?.cards).toEqual(canvas.cards);
});

// ---- applyUserPreset ----------------------------------------------------------------------

const saved = (from: PaneLayout, name = "Review"): UserPreset => ({ name, layout: savedLayoutOf(from) });

it("a saved layout comes back with the same shape for the same number of tabs", () => {
  const source = applyPreset(layoutOf(ids(4)), "focus");
  const out = applyUserPreset(layoutOf(["a", "b", "c", "d"]), saved(source));
  expect(savedLayoutOf(out)).toEqual(savedLayoutOf(source));
  expect([...tabsOf(out.root)].sort()).toEqual(["a", "b", "c", "d"]);
  expect(leafList(out).map((l) => l.tabs)).toEqual([["a"], ["b"], ["c"], ["d"]]);
});

it("fewer tabs drop panes, more tabs join the last pane, and no tab is lost", () => {
  const four = saved(applyPreset(layoutOf(ids(4)), "grid"));
  const two = applyUserPreset(layoutOf(["a", "b"]), four);
  expect(leafList(two)).toHaveLength(2);
  expect([...tabsOf(two.root)].sort()).toEqual(["a", "b"]);
  const two2 = saved(layoutOf(ids(2)));
  const five = applyUserPreset(layoutOf(ids(5)), two2);
  expect(leafList(five)).toHaveLength(2);
  expect(leafList(five)[1].tabs).toEqual(["t2", "t3", "t4", "t5"]);
});

it("review tabs join the active pane and the focused pane follows the active tab", () => {
  const base = layoutOf(["a", "b", "review:x"], 1);
  const out = applyUserPreset(base, saved(layoutOf(ids(2))));
  const focused = leafList(out).find((l) => l.id === out.focused)!;
  expect(focused.tabs).toContain("b");
  expect(focused.tabs).toContain("review:x");
  expect(out.expanded).toBeNull();
});

it("an unreadable saved layout, or no tabs, changes nothing", () => {
  const base = layoutOf(ids(3));
  expect(applyUserPreset(base, { name: "x", layout: { v: 2, shape: { kind: "leaf" } } })).toBe(base);
  expect(applyUserPreset(base, { name: "x", layout: "no" })).toBe(base);
  expect(applyUserPreset(base, { name: "x", layout: { v: 1, shape: { kind: "split", dir: "up", sizes: [1, 1], children: [] } } })).toBe(base);
  expect(readSaved(savedLayoutOf(base))).not.toBeNull();
});
