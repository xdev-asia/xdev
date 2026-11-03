import { describe, expect, it } from "vitest";
import {
  addTab,
  closePane,
  equalize,
  focusPane,
  leaves,
  neighbour,
  paneOf,
  removeTab,
  replaceTab,
  resize,
  selectTab,
  single,
  splitPane,
  toggleExpand,
  type PaneLayout,
  type PaneNode,
} from "./paneTree";

const ids = (l: PaneLayout) => leaves(l).map((n) => (n.kind === "leaf" ? n.tabs.join("+") : ""));

/** a | (b / c) */
function three(): PaneLayout {
  let l = single("a");
  l = splitPane(l, l.focused, "right", "b");
  l = splitPane(l, l.focused, "down", "c");
  return l;
}

describe("paneTree", () => {
  it("single makes one focused leaf", () => {
    const l = single("a");
    expect(ids(l)).toEqual(["a"]);
    expect(l.focused).toBe(leaves(l)[0].id);
    expect(l.expanded).toBeNull();
  });

  it("addTab goes to the focused pane by default and activates", () => {
    const l = addTab(single("a"), "b");
    expect(ids(l)).toEqual(["a+b"]);
    expect((leaves(l)[0] as { active: string }).active).toBe("b");
  });

  it("addTab with a pane id targets that pane; a known tab is a no-op", () => {
    const l = three();
    const first = leaves(l)[0].id;
    const l2 = addTab(l, "d", first);
    expect(ids(l2)).toEqual(["a+d", "b", "c"]);
    expect(addTab(l2, "d")).toBe(l2);
  });

  it("splitPane nests and focuses the new pane", () => {
    const l = three();
    expect(ids(l)).toEqual(["a", "b", "c"]);
    expect(paneOf(l, "c")).toBe(l.focused);
    const root = l.root as Extract<PaneNode, { kind: "split" }>;
    expect(root.dir).toBe("right");
    expect(root.children[1].kind).toBe("split");
  });

  it("splitting again in the same direction flattens into a sibling", () => {
    let l = single("a");
    l = splitPane(l, l.focused, "right", "b");
    l = splitPane(l, l.focused, "right", "c");
    const root = l.root as Extract<PaneNode, { kind: "split" }>;
    expect(root.children).toHaveLength(3);
    expect(root.sizes.reduce((s, n) => s + n, 0)).toBeCloseTo(1);
    expect(ids(l)).toEqual(["a", "b", "c"]);
  });

  it("splitPane on an unknown pane, a known tab, or the review tab is a no-op", () => {
    const l = single("a");
    expect(splitPane(l, "nope", "right", "b")).toBe(l);
  });

  it("closing the last tab of a pane removes it and collapses the parent", () => {
    const l = three();
    const l2 = removeTab(l, "c")!;
    expect(ids(l2)).toEqual(["a", "b"]);
    const root = l2.root as Extract<PaneNode, { kind: "split" }>;
    expect(root.dir).toBe("right");
    expect(root.children.every((c) => c.kind === "leaf")).toBe(true);
    const l3 = removeTab(l2, "b")!;
    expect(l3.root.kind).toBe("leaf");
    expect(removeTab(l3, "a")).toBeNull();
  });

  it("removing a tab moves focus off a vanished pane and picks a new active tab", () => {
    let l = addTab(single("a"), "b");
    l = removeTab(l, "b")!;
    expect((leaves(l)[0] as { active: string }).active).toBe("a");
    const t = three();
    const t2 = removeTab(t, "c")!;
    expect(leaves(t2).some((n) => n.id === t2.focused)).toBe(true);
  });

  it("removeTab of an unknown tab returns the same reference", () => {
    const l = three();
    expect(removeTab(l, "zzz")).toBe(l);
  });

  it("closePane removes all its tabs; the last pane gives null", () => {
    const l = three();
    const mid = paneOf(l, "b")!;
    const l2 = closePane(l, mid)!;
    expect(ids(l2)).toEqual(["a", "c"]);
    expect(closePane(single("a"), "p1")).toBeNull();
    expect(closePane(l, "nope")).toBe(l);
  });

  it("focusPane and selectTab", () => {
    const l = three();
    const a = paneOf(l, "a")!;
    const l2 = focusPane(l, a);
    expect(l2.focused).toBe(a);
    expect(focusPane(l2, a)).toBe(l2);
    expect(focusPane(l2, "nope")).toBe(l2);
    const l3 = addTab(l2, "x");
    const l4 = selectTab(l3, "c");
    expect(l4.focused).toBe(paneOf(l4, "c"));
    const l5 = selectTab(l4, "a");
    expect((leaves(l5)[0] as { active: string }).active).toBe("a");
    expect(selectTab(l5, "a")).toBe(l5);
    expect(selectTab(l5, "nope")).toBe(l5);
  });

  it("neighbour wraps in reading order", () => {
    const l = three();
    const [a, b, c] = leaves(l).map((n) => n.id);
    expect(neighbour(l, a, 1)).toBe(b);
    expect(neighbour(l, c, 1)).toBe(a);
    expect(neighbour(l, a, -1)).toBe(c);
    expect(neighbour(l, b, -1)).toBe(a);
  });

  it("toggleExpand twice restores", () => {
    const l = three();
    const b = paneOf(l, "b")!;
    const e = toggleExpand(l, b);
    expect(e.expanded).toBe(b);
    const back = toggleExpand(e, b);
    expect(back.expanded).toBeNull();
    expect(back.root).toBe(l.root);
  });

  it("toggleExpand on a lone pane is a no-op", () => {
    const l = single("a");
    expect(toggleExpand(l, l.focused)).toBe(l);
  });

  it("expanding another pane while expanded moves the expansion (R4)", () => {
    const l = three();
    const a = paneOf(l, "a")!;
    const b = paneOf(l, "b")!;
    const e = toggleExpand(toggleExpand(l, a), b);
    expect(e.expanded).toBe(b);
    expect(e.focused).toBe(b);
  });

  it("focusing while expanded moves the expansion to that pane", () => {
    const l = three();
    const a = paneOf(l, "a")!;
    const b = paneOf(l, "b")!;
    const e = focusPane(toggleExpand(l, a), b);
    expect(e.expanded).toBe(b);
  });

  it("removing the expanded pane clears expansion", () => {
    const l = three();
    const b = paneOf(l, "b")!;
    const e = toggleExpand(l, b);
    expect(removeTab(e, "b")!.expanded).toBeNull();
  });

  it("equalize gives equal sizes at every level", () => {
    let l = three();
    const outer = (l.root as Extract<PaneNode, { kind: "split" }>).id;
    l = resize(l, outer, [0.7, 0.3]);
    const e = equalize(l);
    const root = e.root as Extract<PaneNode, { kind: "split" }>;
    expect(root.sizes).toEqual([0.5, 0.5]);
    const inner = root.children[1] as Extract<PaneNode, { kind: "split" }>;
    expect(inner.sizes).toEqual([0.5, 0.5]);
    expect(equalize(e)).toBe(e);
    expect(equalize(single("a"))).toEqual(single("a"));
  });

  it("resize clamps to 0.1 and keeps the sum at 1", () => {
    const l = three();
    const id = (l.root as Extract<PaneNode, { kind: "split" }>).id;
    const r = resize(l, id, [0.99, 0.01]);
    const s = (r.root as Extract<PaneNode, { kind: "split" }>).sizes;
    expect(s[1]).toBeCloseTo(0.1);
    expect(s[0]).toBeCloseTo(0.9);
    expect(s[0] + s[1]).toBeCloseTo(1);
  });

  it("resize ignores wrong length, unknown split and unchanged sizes", () => {
    const l = three();
    const root = l.root as Extract<PaneNode, { kind: "split" }>;
    expect(resize(l, root.id, [1])).toBe(l);
    expect(resize(l, "nope", [0.5, 0.5])).toBe(l);
    expect(resize(l, root.id, root.sizes)).toBe(l);
  });

  it("paneOf finds the pane or null", () => {
    const l = three();
    expect(paneOf(l, "zzz")).toBeNull();
    expect(paneOf(l, "a")).toBe(leaves(l)[0].id);
  });

  it("replaceTab swaps in place and keeps the active mark", () => {
    const l = addTab(three(), "x", paneOf(three(), "a") ?? undefined);
    const r = replaceTab(l, "b", "b2");
    expect(paneOf(r, "b2")).toBe(paneOf(l, "b"));
    expect(paneOf(r, "b")).toBeNull();
    expect(replaceTab(r, "nope", "z")).toBe(r);
  });
});
