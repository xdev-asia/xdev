import { expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings, toggleColumn, type KanbanSettings } from "./kanbanSettings";

const fake = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m } as unknown as Storage & { map: Map<string, string> };
};

it("defaults to every column and comfortable cards", () => {
  expect(DEFAULT_SETTINGS).toEqual({ hidden: [], density: "comfortable" });
});

it("falls back to defaults for missing, broken or mistyped storage", () => {
  expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings("{bad")).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings('{"hidden":"x"}')).toEqual(DEFAULT_SETTINGS);
});

it("drops unknown column ids and density values", () => {
  expect(parseSettings('{"hidden":["completed","nope",3],"density":"huge"}')).toEqual({ hidden: ["completed"], density: "comfortable" });
  expect(parseSettings('{"hidden":[],"density":"compact"}').density).toBe("compact");
});

it("never hides every column", () => {
  expect(parseSettings('{"hidden":["todo","in-progress","in-review","completed","none"]}').hidden).toEqual([]);
});

it("toggles a column and keeps the last visible one", () => {
  const hidden = toggleColumn(DEFAULT_SETTINGS, "completed");
  expect(hidden.hidden).toEqual(["completed"]);
  expect(toggleColumn(hidden, "completed").hidden).toEqual([]);
  const one: KanbanSettings = { hidden: ["todo", "in-progress", "in-review", "completed"], density: "comfortable" };
  expect(toggleColumn(one, "none")).toBe(one);
});

it("loads and saves through a storage, and survives a throwing one", () => {
  const store = fake();
  saveSettings({ hidden: ["none"], density: "compact" }, store);
  expect(loadSettings(store)).toEqual({ hidden: ["none"], density: "compact" });
  const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } } as unknown as Storage;
  expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
  expect(() => saveSettings(DEFAULT_SETTINGS, bad)).not.toThrow();
});
