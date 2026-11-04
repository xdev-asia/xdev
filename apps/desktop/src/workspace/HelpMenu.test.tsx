import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { HELP_ITEMS, HelpMenu } from "./HelpMenu";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string) => translate("en", key);

it("lists shortcuts, the links, then about and restart, in that order", () => {
  expect(HELP_ITEMS.map((i) => i.id)).toEqual(["shortcuts", "separator", "docs", "getting-started", "changelog", "report-issue", "source", "separator", "about", "restart"]);
});

it("renders every item as a menu item with its label", () => {
  const html = renderToStaticMarkup(<HelpMenu onPick={() => {}} />);
  for (const key of ["shortcuts", "docs", "gettingStarted", "changelog", "reportIssue", "source", "about", "restart"]) {
    expect(html).toContain(en(`shell.help.${key}`));
  }
  expect(html.match(/role="menuitem"/g)).toHaveLength(8);
  expect(html.match(/role="separator"/g)).toHaveLength(2);
});
