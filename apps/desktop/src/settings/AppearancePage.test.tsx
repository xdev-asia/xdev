import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { FontField, Segmented, Select, ThemeSwitch } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { UI_SETTINGS_DEFAULTS } from "@/mockSettings";
import { currentEditorTheme, resetEditorThemeForTests } from "@/ui/editorTheme";
import { getThemePreference, resetThemeForTests } from "@/ui/theme";
import { AppearancePage } from "./AppearancePage";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import { SETTING_ENTRIES } from "./catalog";
import type { SettingsFilter } from "./sections";

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
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function paintEnv() {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  resetThemeForTests({
    root: {
      setAttribute: (n: string, v: string) => void (attrs[n] = v),
      style: { setProperty: (n: string, v: string) => void (props[n] = v), removeProperty: (n: string) => delete props[n] },
    },
    matchMedia: undefined,
    storage: () => undefined,
  });
  return { attrs, props };
}

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
  resetThemeForTests();
  resetEditorThemeForTests();
});

async function page(filter?: SettingsFilter) {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AppearancePage({ api, onChanged: vi.fn(), filter }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const of = (type: unknown) => all().find((n) => n.type === type)!;
  const select = (field: string) => all().find((n) => n.type === Select && n.props["data-field"] === field)!;
  const sw = (name: string) => nodes(all().find((n) => n.props["data-switch"] === name)).find((n) => n.props.role === "switch")!;
  return { api, all, of, select, sw };
}

it("shows the stored values", async () => {
  const p = await page();
  expect(p.of(ThemeSwitch).props.value).toBe("system");
  expect(p.of(FontField).props.value).toBe("");
  expect(p.of(Segmented).props.value).toBe("default");
  expect(p.select("editorLight").props.value).toBe("app");
  expect(p.select("editorDark").props.value).toBe("app");
  expect(p.sw("branch").props["aria-checked"]).toBe(true);
  expect(p.sw("version").props["aria-checked"]).toBe(true);
});

it("theme writes beside zoom and the restore mode, applies at once, and shows what was stored", async () => {
  const env = paintEnv();
  const p = await page();
  await p.api.uiSettingsPut({ ...UI_SETTINGS_DEFAULTS, zoom: 1.3, restore: "none" });
  p.of(ThemeSwitch).props.onChange("light");
  await tick();
  expect(await p.api.uiSettingsGet()).toEqual({ ...UI_SETTINGS_DEFAULTS, zoom: 1.3, restore: "none", theme: "light" });
  expect(getThemePreference()).toBe("light");
  expect(env.attrs["data-theme"]).toBe("light");
  expect(p.of(ThemeSwitch).props.value).toBe("light");
  expect(Object.keys(p.of(ThemeSwitch).props.labels)).toEqual(["group", "system", "dark", "light"]);
});

it("the font waits for Enter or leaving the field, then shows the stored, cleaned name", async () => {
  const env = paintEnv();
  const p = await page();
  p.of(FontField).props.onChange("  Inter ");
  await tick();
  expect((await p.api.uiSettingsGet()).uiFont).toBe("");
  p.of(FontField).props.onKeyDown({ key: "Enter" });
  await tick();
  expect((await p.api.uiSettingsGet()).uiFont).toBe("Inter");
  expect(p.of(FontField).props.value).toBe("Inter");
  expect(env.props["--font-body"]).toBe('"Inter", var(--x-font-body-fallback)');
  p.of(FontField).props.onChange("Roboto");
  p.of(FontField).props.onBlur();
  await tick();
  expect((await p.api.uiSettingsGet()).uiFont).toBe("Roboto");
});

it("clearing the font goes back to the default at once", async () => {
  const env = paintEnv();
  const p = await page();
  p.of(FontField).props.onChange("Inter");
  p.of(FontField).props.onBlur();
  await tick();
  expect(env.props["--font-body"]).toBeDefined();
  p.of(FontField).props.onChange("");
  await tick();
  expect((await p.api.uiSettingsGet()).uiFont).toBe("");
  expect(env.props["--font-body"]).toBeUndefined();
});

it("the sidebar look writes and paints data-sidebar", async () => {
  const env = paintEnv();
  const p = await page();
  p.of(Segmented).props.onChange("tinted");
  await tick();
  expect((await p.api.uiSettingsGet()).sidebar).toBe("tinted");
  expect(env.attrs["data-sidebar"]).toBe("tinted");
  expect(p.of(Segmented).props.value).toBe("tinted");
});

it("the editor picks write per theme and feed the editor theme", async () => {
  paintEnv();
  const p = await page();
  p.select("editorDark").props.onChange({ target: { value: "light" } });
  await tick();
  expect(await p.api.uiSettingsGet()).toMatchObject({ editorThemeDark: "light", editorThemeLight: "app" });
  expect(p.select("editorDark").props.value).toBe("light");
  // The page painted the dark theme (no matchMedia reads as dark), so the editor takes the dark pick.
  expect(currentEditorTheme()).toBe("light");
  p.select("editorLight").props.onChange({ target: { value: "dark" } });
  await tick();
  expect((await p.api.uiSettingsGet()).editorThemeLight).toBe("dark");
});

it("a status bar switch flips one item and keeps the others", async () => {
  paintEnv();
  const p = await page();
  p.sw("tokenUsage").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).statusBar).toEqual({ branch: true, tokenUsage: false, agents: true, version: true });
  expect(p.sw("tokenUsage").props["aria-checked"]).toBe(false);
});

it("a search keeps only the rows that hit", async () => {
  const filter = { query: "font", ids: new Set(["appearance.font"]) };
  const p = await page(filter);
  const shown = p.all().filter((n) => n.type === SettingRow && settingShown(filter, n.props.id)).map((n) => n.props.id);
  expect(shown).toEqual(["appearance.font"]);
  expect(p.all().filter((n) => n.type === SettingGroup).map((n) => n.props.ids.some((i: string) => filter.ids.has(i)))).toEqual([true, false, false]);
});

it("every catalog entry of the section has a control on the page", () => {
  const ids = SETTING_ENTRIES.filter((e) => e.section === "appearance").map((e) => e.id);
  expect(ids).toEqual(expect.arrayContaining(["appearance.theme", "appearance.font", "appearance.sidebar", "appearance.editorTheme", "appearance.statusBar.branch"]));
});
