import { beforeEach, expect, it, vi } from "vitest";
import { getHiddenApps, resetHiddenAppsForTests, setHiddenApps, subscribeHiddenApps } from "./hiddenApps";

beforeEach(() => resetHiddenAppsForTests());

it("starts with nothing hidden", () => {
  expect(getHiddenApps()).toEqual([]);
});

it("tells readers once per real change", () => {
  const listener = vi.fn();
  subscribeHiddenApps(listener);
  setHiddenApps(["kit"]);
  setHiddenApps(["kit"]);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(getHiddenApps()).toEqual(["kit"]);
  setHiddenApps([]);
  expect(listener).toHaveBeenCalledTimes(2);
});
