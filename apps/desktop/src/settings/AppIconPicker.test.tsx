import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { APP_ICONS } from "@/ui/appIcon";
import { AppearancePage } from "./AppearancePage";
import { AppIconPicker, APP_ICON_IMAGES } from "./AppIconPicker";

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
const radios = (tree: unknown) => nodes(tree).filter((n) => n.type === "input" && n.props.type === "radio");

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
});

it("renders the six icons as one named radio group, each option labelled by its name", () => {
  const html = renderToStaticMarkup(<AppIconPicker value="default" labelledBy="app-icon-label" onPick={vi.fn()} />);
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-labelledby="app-icon-label"');
  expect(html.match(/type="radio"/g)).toHaveLength(6);
  for (const name of ["Default", "Midnight", "Light", "Sunset", "Forest", "Mono"]) expect(html).toContain(`>${name}</span>`);
  // The thumbnail is decorative: the name labels the option.
  expect(html.match(/alt=""/g)).toHaveLength(6);
});

it("every option has its own thumbnail", () => {
  const tree = AppIconPicker({ value: "default", labelledBy: "l", onPick: vi.fn() });
  const images = nodes(tree).filter((n) => n.type === "img").map((n) => n.props.src);
  expect(images).toEqual(APP_ICONS.map((id) => APP_ICON_IMAGES[id]));
  expect(new Set(images).size).toBe(6);
});

it("checks the current icon only, and the default for an unknown id", () => {
  const checked = (value: string) => radios(AppIconPicker({ value, labelledBy: "l", onPick: vi.fn() })).filter((r) => r.props.checked).map((r) => r.props.value);
  expect(checked("sunset")).toEqual(["sunset"]);
  expect(checked("rainbow")).toEqual(["default"]);
});

it("picking an option reports its id", () => {
  const onPick = vi.fn();
  radios(AppIconPicker({ value: "default", labelledBy: "l", onPick })).find((r) => r.props.value === "forest")!.props.onChange();
  expect(onPick).toHaveBeenCalledWith("forest");
});

async function page() {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AppearancePage({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const picker = () => nodes(draw()).find((n) => n.type === AppIconPicker)!;
  return { api, picker };
}

it("the Appearance page shows the stored icon and a pick calls the api, then shows what was stored", async () => {
  const p = await page();
  expect(p.picker().props.value).toBe("default");
  const set = vi.spyOn(p.api, "appIconSet");
  p.picker().props.onPick("midnight");
  await tick();
  expect(set).toHaveBeenCalledWith("midnight");
  expect((await p.api.uiSettingsGet()).appIcon).toBe("midnight");
  expect(p.picker().props.value).toBe("midnight");
});

it("picking the icon already in use does not write", async () => {
  const p = await page();
  const set = vi.spyOn(p.api, "appIconSet");
  p.picker().props.onPick("default");
  await tick();
  expect(set).not.toHaveBeenCalled();
});

it("another view setting keeps the picked icon", async () => {
  const p = await page();
  await p.api.appIconSet("mono");
  const ui = await p.api.uiSettingsGet();
  expect((await p.api.uiSettingsPut({ ...ui, zoom: 1.2 })).appIcon).toBe("mono");
  expect((await p.api.uiSettingsPut({ ...ui, appIcon: "../x" })).appIcon).toBe("default");
});
