import { describe, expect, it, vi } from "vitest";
import { NAV_CAP, NavHistory } from "./navHistory";

const all = () => true;

describe("NavHistory", () => {
  it("walks back and forward like a browser", () => {
    const h = new NavHistory();
    h.visit("A", null);
    h.visit("B", null);
    h.visit("C", null);
    expect(h.back(all)?.worktree).toBe("B");
    expect(h.back(all)?.worktree).toBe("A");
    expect(h.back(all)).toBeNull();
    expect(h.forward(all)?.worktree).toBe("B");
  });

  it("cuts the forward part on a new worktree", () => {
    const h = new NavHistory();
    h.visit("A", null);
    h.visit("B", null);
    h.visit("C", null);
    h.back(all);
    h.back(all);
    h.visit("D", null);
    expect(h.canForward(all)).toBe(false);
    expect(h.back(all)?.worktree).toBe("A");
  });

  it("remembers the tab per entry and only refreshes it on the current worktree", () => {
    const h = new NavHistory();
    h.visit("A", "t1");
    h.visit("B", "t2");
    h.visit("B", "t3");
    expect(h.back(all)).toEqual({ worktree: "A", tab: "t1" });
    expect(h.forward(all)).toEqual({ worktree: "B", tab: "t3" });
  });

  it("does not push when visiting the entry at the index after back", () => {
    const h = new NavHistory();
    h.visit("A", null);
    h.visit("B", null);
    h.back(all);
    h.visit("A", "x");
    expect(h.canForward(all)).toBe(true);
    expect(h.forward(all)).toEqual({ worktree: "B", tab: null });
    h.back(all);
    expect(h.back(all)).toBeNull();
  });

  it("ignores a null worktree", () => {
    const h = new NavHistory();
    const v = h.version();
    h.visit(null as unknown as string, null);
    expect(h.version()).toBe(v);
    expect(h.canBack(all)).toBe(false);
  });

  it("skips and drops dead entries", () => {
    const h = new NavHistory();
    h.visit("A", null);
    h.visit("B", null);
    h.visit("C", null);
    const alive = (w: string) => w !== "B";
    expect(h.canBack(alive)).toBe(true);
    expect(h.back(alive)?.worktree).toBe("A");
    expect(h.forward(alive)?.worktree).toBe("C");
    // B is gone for good.
    expect(h.back(all)?.worktree).toBe("A");
    expect(h.back(all)).toBeNull();
  });

  it("merges the runs of one worktree that dropping a dead entry leaves side by side", () => {
    const h = new NavHistory();
    h.visit("X", null);
    h.visit("A", "t1");
    h.visit("B", null);
    h.visit("A", "t2");
    const alive = (w: string) => w !== "B";
    // A, dead B, A: back skips both and lands on X, not on the same worktree.
    expect(h.back(alive)?.worktree).toBe("X");
    const seen: (string | null)[] = [];
    let e;
    while ((e = h.forward(all))) seen.push(`${e.worktree}:${e.tab}`);
    // One A is left, the newest, with its tab.
    expect(seen).toEqual(["A:t2"]);
  });

  it("drops a dead run behind without leaving the current worktree twice", () => {
    const h = new NavHistory();
    h.visit("A", null);
    h.visit("B", null);
    h.visit("A", "t");
    const alive = (w: string) => w !== "B";
    expect(h.canBack(alive)).toBe(false);
    expect(h.back(alive)).toBeNull();
    expect(h.back(all)).toBeNull();
    expect(h.forward(all)).toBeNull();
  });

  it("returns null and stays put when everything behind is dead", () => {
    const h = new NavHistory();
    h.visit("A", null);
    h.visit("B", null);
    expect(h.canBack((w) => w === "B")).toBe(false);
    expect(h.back((w) => w === "B")).toBeNull();
    expect(h.canBack(all)).toBe(false);
  });

  it("keeps the newest NAV_CAP entries", () => {
    const h = new NavHistory();
    for (let i = 0; i <= NAV_CAP; i++) h.visit(`w${i}`, null);
    let n = 0;
    while (h.back(all)) n++;
    expect(n).toBe(NAV_CAP - 1);
    expect(h.forward(all)?.worktree).toBe("w2");
  });

  it("hands out the same bound subscribe and version each time", () => {
    const h = new NavHistory();
    const { subscribe, version } = h;
    expect(h.subscribe).toBe(subscribe);
    const fn = vi.fn();
    subscribe(fn);
    h.visit("A", null);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(version()).toBe(h.version());
  });

  it("notifies subscribers and bumps the version on each change", () => {
    const h = new NavHistory();
    const fn = vi.fn();
    const off = h.subscribe(fn);
    const v0 = h.version();
    h.visit("A", null);
    h.visit("B", null);
    h.back(all);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(h.version()).toBe(v0 + 3);
    off();
    h.forward(all);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
