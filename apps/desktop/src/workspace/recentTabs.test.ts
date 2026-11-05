import { expect, it } from "vitest";
import { createMockApi } from "@/api";
import { mruOrder } from "./tabNav";
import { chosenTab, startSwitch, stepSwitch } from "./recentTabs";
import { Sessions } from "./sessions";

const W = "/demo/wt/xdev-oak";

it("the first tab goes one step from the front tab; fewer than two tabs open nothing", () => {
  expect(startSwitch(["c", "b", "a"], "c", 1)).toEqual({ list: ["c", "b", "a"], at: 1, steps: 1 });
  expect(startSwitch(["c", "b", "a"], "c", -1)).toEqual({ list: ["c", "b", "a"], at: 2, steps: 1 });
  expect(startSwitch(["a"], "a", 1)).toBeNull();
  expect(startSwitch([], null, 1)).toBeNull();
  // A front tab that is not in the list starts at the top.
  expect(startSwitch(["c", "b"], "z", 1)?.at).toBe(0);
});

it("the highlight wraps at both ends and counts its steps", () => {
  let walk = startSwitch(["c", "b", "a"], "c", 1)!;
  walk = stepSwitch(walk, 1);
  expect(chosenTab(walk)).toBe("a");
  walk = stepSwitch(walk, 1);
  expect(chosenTab(walk)).toBe("c");
  walk = stepSwitch(walk, -1);
  expect(chosenTab(walk)).toBe("a");
  expect(walk.steps).toBe(4);
  expect(walk.list).toEqual(["c", "b", "a"]);
});

it("the order follows activation and drops closed tabs", () => {
  const live = new Sessions(createMockApi({}));
  try {
    const [a, b, c] = ["shell", "shell", "shell"].map((p) => live.open(W, p as "shell").id);
    const order = () => mruOrder(live.tabs(W).map((t) => t.id), live.recentTabs(W));
    expect(order()).toEqual([a, b, c]);
    live.noteFocused(W, c);
    live.noteFocused(W, a);
    expect(order()).toEqual([a, c, b]);
    live.noteFocused(W, b);
    expect(order()).toEqual([b, a, c]);
    live.close(a);
    expect(order()).toEqual([b, c]);
  } finally {
    live.dispose();
  }
});
