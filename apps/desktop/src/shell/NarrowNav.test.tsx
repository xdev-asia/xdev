import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomNav, type BottomNavItem } from "@xdev-asia/ui";
import { translate } from "@/i18n";

vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

import { NarrowNav, narrowValue, type NarrowPlace } from "./NarrowNav";

const en = (key: string) => translate("en", key);
const bar = (view: Parameters<typeof NarrowNav>[0]["view"], automations: boolean, onPick: (p: NarrowPlace) => void = () => {}) => NarrowNav({ view, automations, onPick });

it("the bar holds Sessions, Docs and Tasks; More lists Squads, Kit, Accounts, Automations when shown, and Settings", () => {
  const nav = bar("workspace", true);
  expect(nav.type).toBe(BottomNav);
  expect((nav.props.items as BottomNavItem[]).map((i) => [i.id, i.label, i.icon])).toEqual([
    ["sessions", en("shell.narrow.sessions"), "terminal"],
    ["docs", en("workspace.nav.docs"), "docs"],
    ["tasks", en("shell.narrow.tasks"), "tasks"],
  ]);
  expect(nav.props.more.label).toBe(en("shell.narrow.more"));
  expect((nav.props.more.items as BottomNavItem[]).map((i) => i.id)).toEqual(["squads", "kit", "accounts", "automations", "settings"]);
  expect((bar("workspace", false).props.more.items as BottomNavItem[]).map((i) => i.id)).toEqual(["squads", "kit", "accounts", "settings"]);
  // Five tabs at most, "more" included.
  expect(nav.props.items.length + 1).toBeLessThanOrEqual(5);
});

it("a place hidden in Settings leaves More", () => {
  const nav = NarrowNav({ view: "workspace", automations: false, places: ["workspace", "docs", "tasks", "accounts"], onPick() {} });
  expect((nav.props.more.items as BottomNavItem[]).map((i) => i.id)).toEqual(["accounts", "settings"]);
});

it("narrowValue maps kit to kit and workspace to sessions", () => {
  expect(narrowValue("kit")).toBe("kit");
  expect(narrowValue("squads")).toBe("squads");
  expect(narrowValue("workspace")).toBe("sessions");
});

it("the tab for the page on screen is current, and a pick names the place", () => {
  expect(narrowValue("workspace")).toBe("sessions");
  expect(narrowValue("docs")).toBe("docs");
  expect(narrowValue("settings")).toBe("settings");
  const picks: NarrowPlace[] = [];
  const nav = bar("automations", true, (p) => picks.push(p));
  expect(nav.props.value).toBe("automations");
  nav.props.onChange("tasks");
  expect(picks).toEqual(["tasks"]);
  const html = renderToStaticMarkup(createElement(NarrowNav, { view: "workspace", automations: false, onPick() {} }));
  expect(html).toContain(`aria-label="${en("shell.narrow.label")}"`);
  expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Sessions/);
});
