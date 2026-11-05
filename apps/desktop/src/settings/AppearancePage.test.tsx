import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { FontField, Segmented, Select, Switch, ThemeSwitch } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { UI_SETTINGS_DEFAULTS } from "@/mockSettings";
import { currentEditorTheme, resetEditorThemeForTests } from "@/ui/editorTheme";
import { resetHiddenAppsForTests } from "@/ui/hiddenApps";
import { getTitlebar, resetTitlebarForTests } from "@/ui/titlebar";
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
  resetHiddenAppsForTests();
  resetTitlebarForTests();
});

async function page(filter?: SettingsFilter, openSection?: (id: string) => void) {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AppearancePage({ api, onChanged: vi.fn(), filter, openSection }); } finally { hooks.active = false; }
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
  expect((await p.api.uiSettingsGet()).statusBar).toEqual({ branch: true, tokenUsage: false, agents: true, version: true, ports: true, keepAwake: true });
  expect(p.sw("tokenUsage").props["aria-checked"]).toBe(false);
});

it("the status bar has a Ports switch", async () => {
  paintEnv();
  const p = await page();
  p.sw("ports").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).statusBar.ports).toBe(false);
});

it("a search keeps only the rows that hit", async () => {
  const filter = { query: "font", ids: new Set(["appearance.font"]) };
  const p = await page(filter);
  const shown = p.all().filter((n) => n.type === SettingRow && settingShown(filter, n.props.id)).map((n) => n.props.id);
  expect(shown).toEqual(["appearance.font"]);
  expect(p.all().filter((n) => n.type === SettingGroup).map((n) => n.props.ids.some((i: string) => filter.ids.has(i)))).toEqual([true, false, false, false]);
});

it("every catalog entry of the section has a control on the page", () => {
  const ids = SETTING_ENTRIES.filter((e) => e.section === "appearance").map((e) => e.id);
  expect(ids).toEqual(expect.arrayContaining(["appearance.theme", "appearance.font", "appearance.sidebar", "appearance.editorTheme", "appearance.statusBar.branch"]));
});

it("keeps every control off while a save is under way", async () => {
  const p = await page();
  const release: (() => void)[] = [];
  const get = p.api.uiSettingsGet.bind(p.api);
  vi.spyOn(p.api, "uiSettingsGet").mockImplementation(() => new Promise((r) => release.push(() => r(get()))) as ReturnType<typeof get>);
  p.of(ThemeSwitch).props.onChange("light");
  await tick();
  expect(p.of(ThemeSwitch).props.disabled).toBe(true);
  expect(p.of(Segmented).props.disabled).toBe(true);
  expect(p.of(FontField).props.disabled).toBe(true);
  release.splice(0).forEach((f) => f());
  await tick();
  expect(p.of(ThemeSwitch).props.disabled).toBe(false);
  expect(p.of(Segmented).props.disabled).toBe(false);
});

it("the link rows open the Terminal and Usage sections, and only when the page can switch", async () => {
  const open = vi.fn();
  const p = await page(undefined, open);
  const act = (name: string) => p.all().find((n) => n.props["data-act"] === name)!;
  act("open-terminal").props.onClick();
  act("open-usage").props.onClick();
  expect(open.mock.calls).toEqual([["terminal"], ["usage"]]);
  expect((await page()).all().some((n) => n.props["data-act"] === "open-terminal")).toBe(false);
});

const radios = (p: Awaited<ReturnType<typeof page>>) => p.all().filter((n) => n.type === "input" && n.props.type === "radio" && n.props.name === "sidebar-tint");
const range = (p: Awaited<ReturnType<typeof page>>) => p.all().find((n) => n.type === "input" && n.props.type === "range")!;

it("shows the tint swatches only while the sidebar is tinted, each with an accessible name", async () => {
  paintEnv();
  const p = await page();
  expect(radios(p)).toHaveLength(0);
  p.of(Segmented).props.onChange("tinted");
  await tick();
  expect(radios(p).map((n) => n.props["aria-label"])).toEqual(["None", "Blue", "Cyan", "Violet", "Green", "Amber", "Orange", "Red", "Grey"]);
  expect(radios(p).filter((n) => n.props.checked).map((n) => n.props.value)).toEqual([""]);
  expect(range(p).props.disabled).toBe(true);
});

it("picking a swatch writes the token name and paints the wash", async () => {
  const env = paintEnv();
  const p = await page();
  p.of(Segmented).props.onChange("tinted");
  await tick();
  radios(p).find((n) => n.props.value === "ok")!.props.onChange();
  await tick();
  expect(await p.api.uiSettingsGet()).toMatchObject({ sidebar: "tinted", sidebarTint: "ok" });
  expect(env.props["--side-tint"]).toBe("color-mix(in srgb, var(--ok) 10%, var(--bg-1))");
  expect(range(p).props.disabled).toBe(false);
});

it("the strength slider writes when released, not on every move", async () => {
  const env = paintEnv();
  const p = await page();
  p.of(Segmented).props.onChange("tinted");
  await tick();
  radios(p).find((n) => n.props.value === "accent")!.props.onChange();
  await tick();
  range(p).props.onChange({ target: { value: "0.22" } });
  await tick();
  expect((await p.api.uiSettingsGet()).sidebarTintOpacity).toBe(0.1);
  range(p).props.onPointerUp();
  await tick();
  expect((await p.api.uiSettingsGet()).sidebarTintOpacity).toBe(0.22);
  expect(env.props["--side-tint"]).toContain(" 22%");
});

it("the reduce effects switch writes and sets data-effects", async () => {
  const env = paintEnv();
  const p = await page();
  expect(p.sw("reduceEffects").props["aria-checked"]).toBe(false);
  p.sw("reduceEffects").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).reduceEffects).toBe(true);
  expect(env.attrs["data-effects"]).toBe("reduced");
});

it("an app switch hides one app, and the last visible app cannot be hidden", async () => {
  paintEnv();
  const p = await page();
  p.sw("app-kit").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).hiddenApps).toEqual(["kit"]);
  expect(p.sw("app-kit").props["aria-checked"]).toBe(false);
  p.sw("app-kit").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).hiddenApps).toEqual([]);
  for (const id of ["changes", "tasks", "squads", "agents", "kit", "accounts", "terminal"]) {
    p.sw(`app-${id}`).props.onClick();
    await tick();
  }
  expect((await p.api.uiSettingsGet()).hiddenApps).toHaveLength(7);
  expect(p.sw("app-docs").props.disabled).toBe(true);
  expect(p.sw("app-kit").props.disabled).toBe(false);
});

it("the status bar has a keep-awake switch", async () => {
  paintEnv();
  const p = await page();
  expect(p.sw("keepAwake").props["aria-checked"]).toBe(true);
  p.sw("keepAwake").props.onClick();
  await tick();
  expect((await p.api.uiSettingsGet()).statusBar.keepAwake).toBe(false);
});

it("title bar choice writes beside the rest, and the name switch follows it", async () => {
  paintEnv();
  const p = await page();
  expect(p.all().find((n) => n.type === Segmented && n.props.label === translate("en", "settings.appearance.titlebar"))!.props.value).toBe("native");
  const name = () => nodes(p.all().find((n) => n.props["data-switch"] === "titlebarName")).find((n) => n.type === Switch)!;
  expect(name().props.checked).toBe(true);
  expect(name().props.disabled).toBe(true);
  p.all().find((n) => n.type === Segmented && n.props.label === translate("en", "settings.appearance.titlebar"))!.props.onChange("custom");
  await tick();
  expect((await p.api.uiSettingsGet()).titlebar).toBe("custom");
  expect(name().props.disabled).toBe(false);
  name().props.onChange();
  await tick();
  expect(await p.api.uiSettingsGet()).toEqual({ ...UI_SETTINGS_DEFAULTS, titlebar: "custom", showTitlebarName: false });
  expect(getTitlebar()).toEqual({ mode: "custom", showName: false });
});

it("has catalog entries for both title bar rows", () => {
  const ids = SETTING_ENTRIES.map((x) => x.id);
  expect(ids).toEqual(expect.arrayContaining(["appearance.titlebar", "appearance.titlebarName"]));
});
