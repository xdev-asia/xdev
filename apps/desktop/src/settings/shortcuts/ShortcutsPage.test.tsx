import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { resetBindingsForTests, setKeybindingsText } from "@/keys/bindingsStore";
import { ShortcutsPage } from "./ShortcutsPage";

vi.mock("@/i18n", async (original) => ({
  ...await original<typeof import("@/i18n")>(),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const html = (filter?: string) => renderToStaticMarkup(createElement(ShortcutsPage, { api: createMockApi({}), onChanged() {}, filter }));
beforeEach(() => resetBindingsForTests());

it("lists the groups, the chips with counts, the policy and the hints switch", () => {
  const out = html();
  expect(out).toContain(translate("en", "keys.title"));
  expect(out).toContain(translate("en", "keys.group.tabs"));
  expect(out).toContain(translate("en", "keys.action.tab.new"));
  expect(out).toContain(translate("en", "keys.page.appFirst"));
  expect(out).toContain('role="switch"');
  for (const f of ["all", "modified", "unassigned", "conflicts"]) expect(out).toContain(translate("en", `keys.page.filter.${f}`));
});

it("the filter prop preselects the search, so only that action shows", () => {
  const out = html("panel.sourceControl");
  expect(out).toContain('value="panel.sourceControl"');
  expect(out).toContain('data-action="panel.sourceControl"');
  expect(out).not.toContain('data-action="tab.new"');
});

it("shows what the file got wrong, and locks editing while it cannot be read", () => {
  setKeybindingsText("{ not json", "C:/cfg/keybindings.json");
  const out = html();
  expect(out).toContain("C:/cfg/keybindings.json");
  expect(out).toContain('data-kind="parse"');
  expect(out).toContain(translate("en", "keys.page.fixFirst"));
  expect(out).not.toContain(`>${translate("en", "keys.page.add")}<`);
});

it("marks a modified action and offers Reset", () => {
  setKeybindingsText('{"version":1,"keybindings":{"tab.new":["Ctrl+Alt+N"]}}', "p");
  const out = html("tab.new");
  expect(out).toContain("Ctrl+Alt+N");
  expect(out).toContain(translate("en", "keys.page.modified"));
  expect(out).toContain(`>${translate("en", "keys.page.reset")}<`);
});
