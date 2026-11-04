import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { DIFF_DEFAULTS, NAVIGATION_DEFAULTS, UI_SETTINGS_DEFAULTS } from "@/mockSettings";
import { getZoom, resetZoomForTests } from "@/ui/zoom";
import { GeneralPage } from "./GeneralPage";
import { RestoreSetting } from "./RestoreSetting";
import { SETTING_ENTRIES } from "./catalog";
import type { SettingsFilter } from "./sections";
import { SettingGroup, SettingRow } from "./SettingRow";

const i18n = vi.hoisted(() => ({ locale: "en" as "en" | "vi", setLocale: vi.fn() }));
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const slots = hooks.values;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: i18n.locale, setLocale: i18n.setLocale, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
  i18n.locale = "en";
  i18n.setLocale.mockClear();
  resetZoomForTests();
});

async function page(openSection?: (id: string) => void, filter?: SettingsFilter) {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return GeneralPage({ api, onChanged: vi.fn(), openSection, filter }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const sw = (name: string) => nodes(all().find((n) => n.props["data-switch"] === name)).find((n) => n.props.role === "switch")!;
  const by = (attr: string, value: string) => all().find((n) => n.props[attr] === value)!;
  return { api, all, sw, by };
}

it("shows the stored values", async () => {
  const p = await page();
  expect(p.by("data-tab-order", "mru").props["aria-checked"]).toBe(true);
  expect(p.by("data-tab-order", "sequential").props["aria-checked"]).toBe(false);
  expect(p.sw("confirmClosePinned").props["aria-checked"]).toBe(true);
  expect(p.sw("collapseUnchanged").props["aria-checked"]).toBe(true);
  expect(p.sw("wordWrap").props["aria-checked"]).toBe(false);
  expect(p.by("data-diff-view", "inline").props["aria-checked"]).toBe(true);
  expect(p.by("data-field", "zoom").props.value).toBe(1);
});

it("the tab order and the navigation switches write through the api", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "navigationSettingsPut");
  p.by("data-tab-order", "sequential").props.onClick();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...NAVIGATION_DEFAULTS, tabOrder: "sequential" });
  for (const key of ["confirmClosePinned", "confirmCloseRunning", "askBeforeDeleteWorktree"] as const) {
    p.sw(key).props.onClick();
    await tick();
    expect(await p.api.navigationSettings()).toMatchObject({ tabOrder: "sequential", [key]: false });
    expect(p.sw(key).props["aria-checked"]).toBe(false);
  }
});

it("the diff view and the diff switches write through the api", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "diffSettingsPut");
  p.by("data-diff-view", "split").props.onClick();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...DIFF_DEFAULTS, defaultView: "split" });
  for (const key of ["ignoreWhitespace", "collapseUnchanged", "wordWrap", "fileTree"] as const) {
    p.sw(key).props.onClick();
    await tick();
    expect(await p.api.diffSettings()).toMatchObject({ defaultView: "split", [key]: !DIFF_DEFAULTS[key] });
  }
});

it("zoom writes the clamped level beside the restore mode, and Reset goes back to 100 %", async () => {
  const p = await page();
  await p.api.uiSettingsPut({ ...UI_SETTINGS_DEFAULTS, restore: "none" });
  p.by("data-field", "zoom").props.onChange({ target: { value: "1.5" } });
  await tick();
  expect(await p.api.uiSettingsGet()).toEqual({ ...UI_SETTINGS_DEFAULTS, zoom: 1.5, restore: "none" });
  expect(getZoom()).toBe(1.5);
  expect(p.by("data-field", "zoom").props.value).toBe(1.5);
  // Outside the range it is clamped, as everywhere else.
  p.by("data-field", "zoom").props.onChange({ target: { value: "9" } });
  await tick();
  expect((await p.api.uiSettingsGet()).zoom).toBe(2);
  p.by("data-act", "zoom-reset").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).zoom).toBe(1);
  expect(getZoom()).toBe(1);
});

it("lists 50 % to 200 % in steps of 10 %", async () => {
  const p = await page();
  const options = nodes(p.by("data-field", "zoom")).filter((n) => n.type === "option").map((n) => n.props.value);
  expect(options[0]).toBe(0.5);
  expect(options.at(-1)).toBe(2);
  expect(options).toHaveLength(16);
});

it("holds the restore setting and a link to Open In apps", async () => {
  const open = vi.fn();
  const p = await page(open);
  expect(p.all().some((n) => n.type === RestoreSetting)).toBe(true);
  p.by("data-act", "open-in").props.onClick();
  expect(open).toHaveBeenCalledWith("openIn");
});

it("every General catalog entry has a row on the page", async () => {
  const p = await page(vi.fn());
  const shown = new Set([
    ...p.all().filter((n) => n.type === SettingRow).map((n) => n.props.id),
    ...p.all().filter((n) => n.props["data-setting-id"]).map((n) => n.props["data-setting-id"]),
  ]);
  const ids = SETTING_ENTRIES.filter((e) => e.section === "general").map((e) => e.id);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(shown.has(id), id).toBe(true);
  expect(p.all().find((n) => n.type === SettingRow && n.props.id === "general.restore")!.props.children.type).toBe(RestoreSetting);
});

it("a search keeps only the matching controls and the groups that hold them", async () => {
  const p = await page(vi.fn(), { query: "wrap", ids: new Set(["general.diff.wordWrap"]) });
  expect(p.all().some((n) => n.props["data-switch"] === "wordWrap")).toBe(true);
  expect(p.all().some((n) => n.props["data-switch"] === "confirmClosePinned")).toBe(false);
  const groups = p.all().filter((n) => n.type === SettingGroup);
  expect(groups.map((g) => SettingGroup(g.props as Parameters<typeof SettingGroup>[0]) !== null)).toEqual([false, false, true]);
  const zoom = p.all().find((n) => n.type === SettingRow && n.props.id === "general.zoom")!;
  expect(SettingRow(zoom.props as Parameters<typeof SettingRow>[0])).toBeNull();
});

it("the language row shows the current language and changes it through setLocale", async () => {
  i18n.locale = "vi";
  const p = await page();
  const select = p.by("data-field", "language");
  expect(select.props.value).toBe("vi");
  expect(nodes(select).filter((n) => n.type === "option").map((n) => n.props.value)).toEqual(["en", "vi"]);
  select.props.onChange({ target: { value: "en" } });
  expect(i18n.setLocale).toHaveBeenCalledWith("en");
  expect(SETTING_ENTRIES.find((x) => x.id === "general.language")).toMatchObject({ section: "general", titleKey: "language.label" });
});
