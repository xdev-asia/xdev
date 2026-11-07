import { expect, it } from "vitest";
import { APPS } from "./apps";
import { APP_HOME, docsSections, MOVABLE, railPlaces } from "./places";

it("every app id has a home or is dropped", () => {
  expect(Object.keys(APP_HOME).sort()).toEqual([...APPS].sort());
  expect(APP_HOME.terminal).toBe("dropped");
  expect(APP_HOME.changes).toEqual({ place: "docs", section: "changes" });
  expect(APP_HOME.agents).toEqual({ place: "docs", section: "agents" });
});

it("the movable places are tasks, squads, kit and accounts", () => {
  expect([...MOVABLE]).toEqual(["tasks", "squads", "kit", "accounts"]);
});

it("rail starts with workspace and docs, then the movable places in the saved order", () => {
  expect(railPlaces([], ["accounts", "kit", "squads", "tasks"], false)).toEqual(["workspace", "docs", "accounts", "kit", "squads", "tasks"]);
});

it("hidden places leave the rail, docs never does", () => {
  expect(railPlaces(["docs", "terminal", "kit"], [], true)).toEqual(["workspace", "docs", "tasks", "squads", "accounts", "automations"]);
});

it("hiding every movable place shows them all", () => {
  expect(railPlaces(["tasks", "squads", "kit", "accounts"], [], false)).toEqual(["workspace", "docs", "tasks", "squads", "kit", "accounts"]);
});

it("docs section is always first; changes and agents follow order and hidden", () => {
  expect(docsSections(["changes"], ["agents", "changes"])).toEqual(["docs", "agents"]);
  expect(docsSections([], [])).toEqual(["docs", "changes", "agents"]);
  expect(docsSections([], ["agents", "changes"])).toEqual(["docs", "agents", "changes"]);
});
