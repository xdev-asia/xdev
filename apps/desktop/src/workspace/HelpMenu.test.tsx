import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { createMockApi } from "@/mockApi";
import { checkForUpdates, HELP_ITEMS, HelpMenu, runHelpPick } from "./HelpMenu";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string) => translate("en", key);

it("lists shortcuts, the links, then about and restart, in that order", () => {
  expect(HELP_ITEMS.map((i) => i.id)).toEqual(["shortcuts", "replay-tour", "separator", "docs", "getting-started", "changelog", "report-issue", "source", "separator", "check-updates", "reload", "devtools", "separator", "about", "restart"]);
});

it("renders every item as a menu item with its label", () => {
  const html = renderToStaticMarkup(<HelpMenu onPick={() => {}} />);
  for (const key of ["shortcuts", "replayTour", "docs", "gettingStarted", "changelog", "reportIssue", "source", "checkUpdates", "reload", "devtools", "about", "restart"]) {
    expect(html).toContain(en(`shell.help.${key}`));
  }
  expect(html.match(/role="menuitem"/g)).toHaveLength(12);
  expect(html.match(/role="separator"/g)).toHaveLength(3);
});

it("routes each pick to the page or shell call it names", async () => {
  const api = createMockApi({});
  const pages: string[] = [];
  const h = { openSettings: (p: string) => void pages.push(p), openUpdates: () => void pages.push("updates"), openAbout: () => void pages.push("about"), api };
  runHelpPick("shortcuts", h);
  runHelpPick("check-updates", h);
  runHelpPick("about", h);
  expect(pages).toEqual(["keys", "updates", "about"]);
  runHelpPick("reload", h);
  runHelpPick("devtools", h);
  runHelpPick("docs", h);
  runHelpPick("restart", h);
  await Promise.resolve();
  expect(api.__windowCalls()).toEqual({ reloads: 1, devtools: 1 });
  expect(api.__opened()).toEqual(["docs"]);
  expect(api.__quitMode()).toBe("restart");
});

it("Check for updates opens the page and starts a check, even when the check fails", async () => {
  const api = createMockApi({});
  const check = vi.spyOn(api, "updateCheck").mockRejectedValue(new Error("offline"));
  const pages: string[] = [];
  checkForUpdates({ openSettings: (p) => void pages.push(p), api });
  await Promise.resolve();
  expect(pages).toEqual(["general"]);
  expect(check).toHaveBeenCalledWith(false);
});
