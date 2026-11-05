import { beforeEach, expect, it, vi } from "vitest";
import { ALL_ITEMS, getStatusBarItems, resetStatusBarItemsForTests, setStatusBarItems, subscribeStatusBarItems } from "./statusBarItems";

beforeEach(resetStatusBarItemsForTests);

it("starts with every item on", () => {
  expect(getStatusBarItems()).toEqual({ branch: true, tokenUsage: true, agents: true, version: true });
});

it("notifies once per real change", () => {
  const seen = vi.fn();
  const off = subscribeStatusBarItems(seen);
  setStatusBarItems({ ...ALL_ITEMS });
  expect(seen).not.toHaveBeenCalled();
  setStatusBarItems({ ...ALL_ITEMS, version: false });
  expect(seen).toHaveBeenCalledTimes(1);
  expect(getStatusBarItems().version).toBe(false);
  off();
  setStatusBarItems(ALL_ITEMS);
  expect(seen).toHaveBeenCalledTimes(1);
});
