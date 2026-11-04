import { beforeEach, expect, it, vi } from "vitest";
import { currentEditorTheme, editorThemeFor, onEditorThemeChange, resetEditorThemeForTests, setEditorPrefs, setPaintedTheme } from "./editorTheme";

beforeEach(resetEditorThemeForTests);

it("inherits the app theme on app, and takes the pick for the theme in force", () => {
  expect(editorThemeFor("light", { editorThemeLight: "app", editorThemeDark: "app" })).toBeUndefined();
  expect(editorThemeFor("light", { editorThemeLight: "dark", editorThemeDark: "app" })).toBe("dark");
  expect(editorThemeFor("dark", { editorThemeLight: "dark", editorThemeDark: "light" })).toBe("light");
  expect(editorThemeFor("dark", { editorThemeLight: "dark", editorThemeDark: "dark" })).toBe("dark");
});

it("an unknown pick reads as app", () => {
  expect(editorThemeFor("dark", { editorThemeLight: "app", editorThemeDark: "sepia" as never })).toBeUndefined();
});

it("setters notify only on a real change, and the current value follows", () => {
  const seen = vi.fn();
  const off = onEditorThemeChange(seen);
  setPaintedTheme("light");
  expect(seen).toHaveBeenCalledTimes(1);
  setPaintedTheme("light");
  expect(seen).toHaveBeenCalledTimes(1);
  expect(currentEditorTheme()).toBeUndefined();
  setEditorPrefs({ editorThemeLight: "dark", editorThemeDark: "app" });
  expect(seen).toHaveBeenCalledTimes(2);
  expect(currentEditorTheme()).toBe("dark");
  off();
  setPaintedTheme("dark");
  expect(seen).toHaveBeenCalledTimes(2);
  expect(currentEditorTheme()).toBeUndefined();
});
