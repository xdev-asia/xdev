import { describe, expect, it } from "vitest";
import { grantWords, layoutTeam, neighbour, type MapLink } from "./teamLayout";

const link = (from: string, to: string, transcript = false, screen = false): MapLink => ({ from, to, transcript, screen });
const nodes = (...ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));

describe("layoutTeam", () => {
  it("layers tabs by the longest chain of links into them", () => {
    const l = layoutTeam(nodes("a", "b", "c", "d"), [link("a", "b"), link("b", "c"), link("a", "c")]);
    const layer = Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 2, d: 0 });
    expect(l.edges).toHaveLength(3);
  });

  it("is the same for the same input in any order", () => {
    const one = layoutTeam(nodes("c", "a", "b"), [link("a", "b"), link("a", "c")]);
    const two = layoutTeam(nodes("b", "c", "a"), [link("a", "c"), link("a", "b")]);
    expect(one.nodes).toEqual(two.nodes);
  });

  it("orders a layer by label and keeps rows apart", () => {
    const l = layoutTeam(nodes("z", "m", "a"), []);
    expect(l.nodes.map((n) => [n.id, n.index])).toEqual([["a", 0], ["m", 1], ["z", 2]]);
    expect(new Set(l.nodes.map((n) => n.y)).size).toBe(3);
  });

  it("survives a cycle and drops links to unknown tabs or to itself", () => {
    const l = layoutTeam(nodes("a", "b"), [link("a", "b"), link("b", "a"), link("a", "x"), link("a", "a")]);
    expect(l.nodes).toHaveLength(2);
    expect(l.edges).toHaveLength(2);
    expect(new Set(l.nodes.map((n) => n.layer)).size).toBe(2);
  });

  it("grows with layers and rows", () => {
    const small = layoutTeam(nodes("a"), []);
    const big = layoutTeam(nodes("a", "b", "c"), [link("a", "b"), link("a", "c")]);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
  });
});

describe("neighbour", () => {
  const l = layoutTeam(nodes("a", "b", "c", "d"), [link("a", "b"), link("a", "c"), link("b", "d")]);

  it("moves across layers to the nearest row and along a layer", () => {
    expect(neighbour(l, "a", "ArrowRight")).toBe("b");
    expect(neighbour(l, "b", "ArrowDown")).toBe("c");
    expect(neighbour(l, "c", "ArrowRight")).toBe("d");
    expect(neighbour(l, "c", "ArrowLeft")).toBe("a");
    expect(neighbour(l, "c", "ArrowUp")).toBe("b");
  });

  it("goes along a link before going to the nearest row", () => {
    // Layer 0 holds A, B and Z; only Z links on, to Y.
    const g = layoutTeam(nodes("a", "b", "z", "y"), [link("z", "y")]);
    expect(g.nodes.find((n) => n.id === "z")!.index).toBe(2);
    expect(neighbour(g, "y", "ArrowLeft")).toBe("z");
    expect(neighbour(g, "z", "ArrowRight")).toBe("y");
    // A has no link: the nearest row of the next layer.
    expect(neighbour(g, "a", "ArrowRight")).toBe("y");
  });

  it("stays put at an edge and jumps with Home and End", () => {
    expect(neighbour(l, "a", "ArrowLeft")).toBe("a");
    expect(neighbour(l, "a", "ArrowUp")).toBe("a");
    expect(neighbour(l, "c", "Home")).toBe("a");
    expect(neighbour(l, "a", "End")).toBe("d");
    expect(neighbour(l, "a", "x")).toBeNull();
  });
});

describe("grantWords", () => {
  it("names the grants that are on", () => {
    expect(grantWords({ transcript: false, screen: false })).toEqual([]);
    expect(grantWords({ transcript: true, screen: true })).toEqual(["transcript", "screen"]);
  });
});
