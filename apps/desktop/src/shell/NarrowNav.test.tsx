import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomNav, type BottomNavItem } from "@xdev-asia/ui";
import { translate } from "@/i18n";

vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

import { NarrowNav, narrowValue, type NarrowPlace } from "./NarrowNav";

const en = (key: string) => translate("en", key);
const bar = (view: Parameters<typeof NarrowNav>[0]["view"], automations: boolean, onPick: (p: NarrowPlace) => void = () => {}) => NarrowNav({ view, automations, onPick });

it("the bar holds Sessions, Tasks and Docs; More lists Automations when shown, Accounts and Settings", () => {
  const nav = bar("workspace", true);
  expect(nav.type).toBe(BottomNav);
  expect((nav.props.items as BottomNavItem[]).map((i) => [i.id, i.label, i.icon])).toEqual([
    ["sessions", en("shell.narrow.sessions"), "terminal"],
    ["tasks", en("shell.narrow.tasks"), "tasks"],
    ["docs", en("workspace.nav.docs"), "docs"],
  ]);
  expect(nav.props.more.label).toBe(en("shell.narrow.more"));
  expect((nav.props.more.items as BottomNavItem[]).map((i) => i.id)).toEqual(["automations", "accounts", "settings"]);
  expect((bar("workspace", false).props.more.items as BottomNavItem[]).map((i) => i.id)).toEqual(["accounts", "settings"]);
  // Five tabs at most, "more" included.
  expect(nav.props.items.length + 1).toBeLessThanOrEqual(5);
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
