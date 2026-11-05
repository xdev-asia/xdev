import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PathSection } from "./PathSection";

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
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
});

async function page() {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return PathSection({ api, separator: ":" }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const entries = () => all().filter((n) => n.type === "li").map((n) => [n.props["data-path-entry"], n.props["data-source"]]);
  const field = (name: string) => all().find((n) => n.props["data-field"] === name)!;
  const type = (v: string) => field("path-entry").props.onChange({ target: { value: v } });
  const add = async () => { all().find((n) => n.props["data-act"] === "path-add")!.props.onClick(); await tick(); };
  const alert = () => all().find((n) => n.props.role === "alert")?.props.children;
  return { api, all, entries, field, type, add, alert };
}

it("lists the system entries read-only and marks a missing folder", async () => {
  const p = await page();
  expect(p.entries()).toEqual([["/usr/local/bin", "system"], ["/usr/bin", "system"], ["/bin", "system"], ["/opt/missing/bin", "system"]]);
  const li = p.all().filter((n) => n.type === "li");
  expect(nodes(li[0]).some((n) => n.type === "button")).toBe(false);
  expect(JSON.stringify(li[3].props.children)).toContain(translate("en", "settings.path.missing"));
});

it("adds a prepend and an append entry in order and removes only the owner's", async () => {
  const p = await page();
  p.type("/mine/bin");
  p.field("path-place").props.onChange({ target: { value: "prepend" } });
  await p.add();
  expect(p.entries()[0]).toEqual(["/mine/bin", "prepend"]);
  expect((await p.api.agentsSettings()).pathPrepend).toEqual(["/mine/bin"]);
  p.type("/late/bin");
  p.field("path-place").props.onChange({ target: { value: "append" } });
  await p.add();
  expect(p.entries().at(-1)).toEqual(["/late/bin", "append"]);
  expect(p.field("path-entry").props.value).toBe("");
  const li = p.all().find((n) => n.type === "li" && n.props["data-path-entry"] === "/mine/bin")!;
  nodes(li).find((n) => n.type === "button")!.props.onClick();
  await tick();
  expect(p.entries().map((e) => e[0])).not.toContain("/mine/bin");
  expect((await p.api.agentsSettings()).pathAppend).toEqual(["/late/bin"]);
});

it("refuses an empty entry and one with the separator, and saves nothing", async () => {
  const p = await page();
  await p.add();
  expect(p.alert()).toBe(translate("en", "settings.path.error.empty"));
  p.type("/a:/b");
  await p.add();
  expect(p.alert()).toBe(translate("en", "settings.path.error.separator"));
  expect((await p.api.agentsSettings()).pathAppend).toEqual([]);
  p.type("/ok");
  expect(p.alert()).toBeUndefined();
});
