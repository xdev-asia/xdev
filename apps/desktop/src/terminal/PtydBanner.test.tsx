import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PtydBanner } from "./PtydBanner";

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
const en = (key: string) => translate("en", key);

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
});

async function banner(setup: (api: ReturnType<typeof createMockApi>) => void) {
  const api = createMockApi({});
  setup(api);
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return PtydBanner({ api }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  return { api, draw, all: () => nodes(draw()) };
}

it("shows nothing while the service runs or is off", async () => {
  expect((await banner((api) => api.__ptydSet({ state: "running" }))).draw()).toBeNull();
  expect((await banner(() => {})).draw()).toBeNull();
});

it("on a fallback says terminals end with xDev, with Retry", async () => {
  const b = await banner((api) => api.__ptydSet({ state: "fallback", reason: "ptyd_start_failed" }));
  const root = b.all()[0];
  expect(root.props.className).toContain("banner");
  expect(root.props.role).toBe("status");
  expect(JSON.stringify(b.all().map((n) => n.props.children))).toContain(en("ptyd.fallback"));
  const restart = vi.spyOn(b.api, "ptydRestart");
  b.all().find((n) => n.type === "button" && n.props.children === en("ptyd.retry"))!.props.onClick();
  await tick();
  expect(restart).toHaveBeenCalledTimes(1);
  // The service answered: the banner goes.
  expect(b.draw()).toBeNull();
});

it("follows ptyd://status as it changes", async () => {
  const b = await banner((api) => api.__ptydSet({ state: "running" }));
  expect(b.draw()).toBeNull();
  b.api.__ptydSet({ state: "fallback", reason: "ptyd_unreachable" });
  await tick();
  expect(b.draw()).not.toBeNull();
});
