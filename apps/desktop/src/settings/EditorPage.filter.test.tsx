import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { EditorPage } from "./EditorPage";
import type { SettingsFilter } from "./sections";

vi.mock("@/i18n", async (original) => ({
  ...await original<typeof import("@/i18n")>(),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const html = (filter?: SettingsFilter) => renderToStaticMarkup(createElement(EditorPage, { api: createMockApi({}), onChanged() {}, filter }));
const all = ["editor.autosave", "editor.wordWrap", "editor.autosaveMs", "editor.fontSize", "editor.fontFamily", "editor.tabSize"];
const ids = (out: string) => [...out.matchAll(/data-setting-id="([^"]+)"/g)].map((m) => m[1]);

it("renders every control when no search is set", () => {
  expect(ids(html())).toEqual(all);
});

it("renders only the controls whose id is a hit", () => {
  const out = html({ query: "font", ids: new Set(["editor.fontSize"]) });
  expect(ids(out)).toEqual(["editor.fontSize"]);
});

it("a filter that holds every id renders every control", () => {
  expect(ids(html({ query: "", ids: new Set(all) }))).toEqual(all);
});
