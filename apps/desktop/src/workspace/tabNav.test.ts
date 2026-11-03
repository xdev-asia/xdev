import { expect, it } from "vitest";
import { cycleTab, nthTab } from "./tabNav";

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
