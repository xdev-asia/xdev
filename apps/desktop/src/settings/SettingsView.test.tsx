import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { AgentsPage } from "./agents/AgentsPage";
import { translate } from "@/i18n";
import { NotificationsPage } from "./notifications/NotificationsPage";
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

it("opens Agents first and switches to Vaults", () => {
  const v = view();
  expect(SECTIONS.map((s) => s.id)).toEqual(["agents", "notifications", "repos", "vaults"]);
  expect(v.items().map((n) => n.props.children)).toEqual([
    en("settings.agents.title"),
    en("settings.notifications.title"),
    en("settings.repos.title"),
    en("settings.vaults.title"),
  ]);
  expect(v.items().map((n) => n.props["aria-current"])).toEqual(["page", undefined, undefined, undefined]);
  expect(v.shown().type).toBe(AgentsPage);
  expect(v.shown().props.api).toBe(v.api);
  expect(v.shown().props.onChanged).toBe(v.onChanged);

  v.items()[3].props.onClick();
  expect(v.items().map((n) => n.props["aria-current"])).toEqual([undefined, undefined, undefined, "page"]);
  expect(v.shown().type).toBe(VaultsSettings);
  expect(v.body().props["aria-label"]).toBe(en("settings.vaults.title"));
});

it("settings_button_opens_agents_page", () => {
  expect(view("agents").shown().type).toBe(AgentsPage);
});

it("an unknown initial section falls back to the first", () => {
  expect(view("vaults").shown().type).toBe(VaultsSettings);
  hooks.values = [];
  expect(view("nope").shown().type).toBe(AgentsPage);
});

it("lists notifications after agents and opens its page", () => {
  const v = view();
  v.items()[1].props.onClick();
  expect(v.items()[1].props["aria-current"]).toBe("page");
  expect(v.shown().type).toBe(NotificationsPage);
  expect(v.body().props["aria-label"]).toBe(en("settings.notifications.title"));
  hooks.values = [];
  expect(view("notifications").shown().type).toBe(NotificationsPage);
});
