import { expect, it } from "vitest";
import { cycleTab, mruOrder, nthTab } from "./tabNav";

it("cycles forward and back, wrapping", () => {
  const ids = ["a", "b", "c"];
  expect(cycleTab(ids, "a", 1)).toBe("b");
  expect(cycleTab(ids, "c", 1)).toBe("a");
  expect(cycleTab(ids, "a", -1)).toBe("c");
  expect(cycleTab(ids, "b", -1)).toBe("a");
});

it("starts at the first tab when none is current, and does nothing with no tabs", () => {
  expect(cycleTab(["a", "b"], null, -1)).toBe("a");
  expect(cycleTab(["a", "b"], "gone", 1)).toBe("a");
  expect(cycleTab([], null, 1)).toBeNull();
});

it("picks the Nth tab, 9 is the last, and a missing one is null", () => {
  const ids = ["a", "b", "c"];
  expect(nthTab(ids, 1)).toBe("a");
  expect(nthTab(ids, 3)).toBe("c");
  expect(nthTab(ids, 4)).toBeNull();
  expect(nthTab(ids, 9)).toBe("c");
  expect(nthTab([], 9)).toBeNull();
});

it("mruOrder puts the most recently used first and the rest in strip order", () => {
  expect(mruOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  expect(mruOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
});

it("mruOrder drops closed tabs, repeats and ids it does not know", () => {
  expect(mruOrder(["a", "b"], ["gone", "b", "b", "a", "gone"])).toEqual(["b", "a"]);
  expect(mruOrder([], ["a"])).toEqual([]);
});

it("mruOrder does not change its inputs", () => {
  const ids = ["a", "b"];
  const recent = ["b"];
  mruOrder(ids, recent);
  expect(ids).toEqual(["a", "b"]);
  expect(recent).toEqual(["b"]);
});
