import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { RestoreSetting } from "./RestoreSetting";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

it("shows the stored mode and writes the pick, keeping the zoom", async () => {
  const api = createMockApi({});
  await api.uiSettingsPut({ zoom: 1.2, restore: "all", theme: "system" });
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return RestoreSetting({ api }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const radio = (m: string) => nodes(draw()).find((n) => n.props["data-restore"] === m)!;
  expect(["all", "agentsOnly", "none"].map((m) => radio(m).props.checked)).toEqual([true, false, false]);
  radio("agentsOnly").props.onChange();
  await tick();
  expect(await api.uiSettingsGet()).toMatchObject({ restore: "agentsOnly", zoom: 1.2 });
  expect(radio("agentsOnly").props.checked).toBe(true);
  radio("none").props.onChange();
  await tick();
  expect((await api.uiSettingsGet()).restore).toBe("none");
});
