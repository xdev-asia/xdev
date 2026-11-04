import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { resetEditorThemeForTests, setEditorPrefs, setPaintedTheme } from "@/ui/editorTheme";
import { DiffView } from "./DiffView";
import { Editor } from "./Editor";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

beforeEach(resetEditorThemeForTests);

const editor = () => renderToStaticMarkup(createElement(Editor, { value: "", onChange() {}, onSave() {} }));
const diff = () => renderToStaticMarkup(createElement(DiffView, { base: "a", current: "b" }));

it("the editor and the diff inherit the app theme on app", () => {
  expect(editor()).not.toContain("data-theme");
  expect(diff()).not.toContain("data-theme");
});

it("the editor and the diff host takes the pick for the painted theme", () => {
  setPaintedTheme("dark");
  setEditorPrefs({ editorThemeLight: "app", editorThemeDark: "light" });
  expect(editor()).toContain('data-theme="light"');
  expect(diff()).toContain('data-theme="light"');
  // The other slot applies once the app theme flips.
  setPaintedTheme("light");
  expect(editor()).not.toContain("data-theme");
});
