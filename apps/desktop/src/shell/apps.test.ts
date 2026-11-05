import { expect, it } from "vitest";
import { APPS, resolveApp, visibleApps } from "./apps";

it("shows every app when none is hidden, ignoring unknown ids", () => {
  expect(visibleApps([])).toEqual([...APPS]);
  expect(visibleApps(["nope"])).toEqual([...APPS]);
});

it("skips hidden apps and keeps the order", () => {
  expect(visibleApps(["changes", "kit"])).toEqual(["docs", "tasks", "squads", "agents", "accounts", "terminal"]);
});

it("keeps at least one app visible", () => {
  expect(visibleApps([...APPS])).toEqual([...APPS]);
  expect(visibleApps(APPS.slice(1))).toEqual(["docs"]);
});

it("falls back to the first visible app when the current one is hidden", () => {
  expect(resolveApp("tasks", [])).toBe("tasks");
  expect(resolveApp("tasks", ["tasks"])).toBe("docs");
  expect(resolveApp("docs", ["docs", "changes"])).toBe("tasks");
  expect(resolveApp("kit", ["nope"])).toBe("kit");
});
