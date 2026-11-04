import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { AgentsPage } from "./agents/AgentsPage";
import { GeneralPage } from "./GeneralPage";
import { translate } from "@/i18n";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { TerminalPage } from "./TerminalPage";
import { SECTIONS } from "./sections";
import { SettingsView } from "./SettingsView";
import { VaultsSettings } from "./VaultsSettings";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  };
  return { ...react, useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)) };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string) => translate("en", key);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.active = false; });

function view(initial?: string) {
  const api = createMockApi({});
  const onChanged = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return nodes(SettingsView({ api, onChanged, initial })); } finally { hooks.active = false; }
  };
  const items = () => draw().filter((n) => n.props.className === "settings-nav-item");
  const body = () => draw().find((n) => n.props.className === "settings-body")!;
  const shown = () => nodes(body().props.children)[0];
  return { api, onChanged, draw, items, body, shown };
}

it("opens General first and switches to Vaults", () => {
  const v = view();
  expect(SECTIONS.map((s) => s.id)).toEqual(["general", "appearance", "account", "agents", "orchestration", "usage", "notifications", "terminal", "editor", "repos", "openIn", "git", "vaults", "keys", "qcmd"]);
  expect(v.items().map((n) => n.props.children)).toEqual([
    en("settings.general.title"),
    en("settings.appearance.title"),
    en("account.title"),
    en("settings.agents.title"),
    en("settings.orchestration.title"),
    en("settings.usage.title"),
    en("settings.notifications.title"),
    en("settings.terminal.title"),
    en("files.settings.title"),
    en("settings.repos.title"),
    en("openIn.title"),
    en("settings.git.title"),
    en("settings.vaults.title"),
    en("keys.title"),
    en("qcmd.title"),
  ]);
  expect(v.items().map((n) => n.props["aria-current"])).toEqual(["page", ...Array(14).fill(undefined)]);
  expect(v.shown().type).toBe(GeneralPage);
  expect(v.shown().props.api).toBe(v.api);
  expect(v.shown().props.onChanged).toBe(v.onChanged);

  v.items()[12].props.onClick();
  expect(v.items().map((n) => n.props["aria-current"])).toEqual([...Array(12).fill(undefined), "page", undefined, undefined]);
  expect(v.shown().type).toBe(VaultsSettings);
  expect(v.body().props["aria-label"]).toBe(en("settings.vaults.title"));
});

it("an initial section opens that page", () => {
  expect(view("agents").shown().type).toBe(AgentsPage);
});

it("an unknown initial section falls back to the first", () => {
  expect(view("vaults").shown().type).toBe(VaultsSettings);
  hooks.values = [];
  expect(view("nope").shown().type).toBe(GeneralPage);
});

it("lists notifications after usage and opens its page", () => {
  const v = view();
  v.items()[5].props.onClick();
  expect(v.items()[5].props["aria-current"]).toBe("page");
  expect(v.shown().type).toBe(NotificationsPage);
  expect(v.body().props["aria-label"]).toBe(en("settings.notifications.title"));
  hooks.values = [];
  expect(view("notifications").shown().type).toBe(NotificationsPage);
});

it("lists terminal after notifications and opens its page", () => {
  const v = view();
  v.items()[6].props.onClick();
  expect(v.items()[6].props["aria-current"]).toBe("page");
  expect(v.shown().type).toBe(TerminalPage);
  expect(v.body().props["aria-label"]).toBe(en("settings.terminal.title"));
  hooks.values = [];
  expect(view("terminal").shown().type).toBe(TerminalPage);
});

// --- settings search ---

import { SettingsSearch } from "./SettingsSearch";

function search(initial?: string, target?: string) {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return nodes(SettingsView({ api, onChanged() {}, initial, target })); } finally { hooks.active = false; }
  };
  const box = () => draw().find((n) => n.type === SettingsSearch)!;
  const items = () => draw().filter((n) => n.props.className === "settings-nav-item");
  const body = () => draw().find((n) => n.props.className === "settings-body")!;
  const page = () => nodes(body().props.children)[0];
  return { draw, box, items, body, page };
}

it("has a search box above the section list", () => {
  const v = search();
  const all = v.draw();
  const nav = all.find((n) => n.props.className === "settings-nav")!;
  expect(nodes(nav.props.children)[0].type).toBe("h2");
  expect(nodes(nav.props.children).findIndex((n) => n.type === SettingsSearch)).toBeLessThan(nodes(nav.props.children).findIndex((n) => n.props.className === "settings-nav-item"));
  expect(v.items()).toHaveLength(SECTIONS.length);
  expect(v.page().props.filter).toBeUndefined();
});

it("a query keeps only the sections with hits, with their hit count", () => {
  const v = search();
  v.box().props.onChange("font");
  const items = v.items();
  expect(items.map((n) => n.props.children[0])).toEqual([en("settings.appearance.title"), en("settings.terminal.title"), en("files.settings.title")]);
  expect(items.every((n) => typeof n.props.children[1] === "object")).toBe(true);
});

it("the page gets the filter, and the active section moves to the best hit when it has none", () => {
  const v = search("agents");
  expect(v.page().type).toBe(AgentsPage);
  v.box().props.onChange("branch prefix");
  expect(v.page().props.filter.query).toBe("branch prefix");
  expect(v.page().props.filter.ids.has("git.prefix")).toBe(true);
  expect(v.page().type).not.toBe(AgentsPage);
  expect(v.items().map((n) => n.props["aria-current"])).toContain("page");
});

it("keeps the active section when it has a hit", () => {
  const v = search("editor");
  v.box().props.onChange("font");
  expect(v.page().props.filter.ids.has("editor.fontSize")).toBe(true);
  expect(v.page().type).toBe(SECTIONS.find((s) => s.id === "editor")!.Component);
});

it("says so when nothing matches", () => {
  const v = search();
  v.box().props.onChange("zzzzqqq");
  expect(v.items()).toHaveLength(0);
  const empty = v.draw().find((n) => n.props.role === "status" && n.props["data-search"] === "none")!;
  expect(empty.props.children).toBe(translate("en", "settings.search.none", { query: "zzzzqqq" }));
});

it("clearing the query shows every section again", () => {
  const v = search();
  v.box().props.onChange("font");
  v.box().props.onChange("");
  expect(v.items()).toHaveLength(SECTIONS.length);
  expect(v.page().props.filter).toBeUndefined();
});

it("a palette target opens its section with the filter holding every id and the target", () => {
  const v = search("git", "git.prefix");
  expect(v.page().props.filter.target).toBe("git.prefix");
  expect(v.page().props.filter.ids.has("git.refresh")).toBe(true);
});

it("hands a section the way to open another one", () => {
  const v = view();
  v.shown().props.openSection("openIn");
  expect(v.items()[9].props["aria-current"]).toBe("page");
  expect(v.body().props["aria-label"]).toBe(en("openIn.title"));
  hooks.values = [];
  const w = view();
  w.shown().props.openSection("nope");
  expect(w.shown().type).toBe(GeneralPage);
});

it("opening another section clears the query so the section shows", () => {
  const v = search();
  v.box().props.onChange("font");
  v.page().props.openSection("openIn");
  expect(v.box().props.value).toBe("");
  expect(v.items()).toHaveLength(SECTIONS.length);
  expect(v.body().props["aria-label"]).toBe(en("openIn.title"));
});
