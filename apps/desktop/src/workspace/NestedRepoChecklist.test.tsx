import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { NestedRepo } from "@/api";
import { translate } from "@/i18n";
import { NestedRepoChecklist, preChecked } from "./NestedRepoChecklist";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }));
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
vi.mock("@/i18n", async (original) => {
  const real = await original<typeof import("@/i18n")>();
  return { ...real, useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => real.translate("en", key, vars) }) };
});

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

const REPOS: NestedRepo[] = [
  { path: "/code/a", name: "a", registered: false },
  { path: "/code/b", name: "b", registered: true },
  { path: "/code/c", name: "c", registered: false },
];

async function view(scan: () => Promise<{ repos: NestedRepo[]; cancelled: boolean }>) {
  const api = { scanNestedRepos: vi.fn(scan), cancelNestedScan: vi.fn(() => Promise.resolve()) };
  const handlers = { onAdd: vi.fn(), onBack: vi.fn() };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return NestedRepoChecklist({ api, root: "/code", ...handlers }); } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  draw();
  const cleanups = hooks.effects.map((e) => e());
  await tick();
  const buttons = () => all().filter((n) => (n.type as { name?: string }).name === "Button" || n.type === "button");
  const text = () => JSON.stringify(draw().props.children);
  return { api, handlers, all, buttons, text, cleanups };
}

it("starts with every repo that is not listed yet", () => {
  expect(preChecked(REPOS)).toEqual(["/code/a", "/code/c"]);
  expect(preChecked([])).toEqual([]);
});

it("scans the root on mount, shows progress with Cancel, and cancels on unmount", async () => {
  const view_ = await view(() => new Promise(() => {}));
  expect(view_.api.scanNestedRepos).toHaveBeenCalledWith("/code");
  expect(view_.text()).toContain(en("nested.scanning"));
  const cancel = view_.buttons().find((n) => n.props.children === en("nested.cancel"))!;
  cancel.props.onClick();
  expect(view_.api.cancelNestedScan).toHaveBeenCalledTimes(1);
  (view_.cleanups[0] as () => void)();
  expect(view_.api.cancelNestedScan).toHaveBeenCalledTimes(2);
});

it("lists what was found with the unlisted ones checked and adds the checked paths", async () => {
  const v = await view(() => Promise.resolve({ repos: REPOS, cancelled: false }));
  const boxes = v.all().filter((n) => typeof n.props.onChange === "function" && "checked" in n.props);
  expect(boxes.map((b) => b.props.checked)).toEqual([true, false, true]);
  expect(boxes[1].props.disabled).toBe(true);
  expect(v.text()).toContain(en("nested.registered"));
  boxes[2].props.onChange({ target: { checked: false } });
  const add = v.buttons().find((n) => n.props.children === en("nested.addSelected", { count: 1 }))!;
  add.props.onClick();
  expect(v.handlers.onAdd).toHaveBeenCalledWith(["/code/a"]);
});

it("disables Add selected when nothing is checked", async () => {
  const v = await view(() => Promise.resolve({ repos: [REPOS[1]], cancelled: false }));
  const add = v.buttons().find((n) => n.props.children === en("nested.addSelected", { count: 0 }))!;
  expect(add.props.disabled).toBe(true);
});

it("keeps a partial result and says the scan stopped early", async () => {
  const v = await view(() => Promise.resolve({ repos: [REPOS[0]], cancelled: true }));
  expect(v.text()).toContain(en("nested.cancelled", { count: 1 }));
});

it("says when nothing was found and when the scan failed", async () => {
  const none = await view(() => Promise.resolve({ repos: [], cancelled: false }));
  expect(none.text()).toContain(en("nested.none"));
  hooks.values = []; hooks.effects = [];
  const bad = await view(() => Promise.reject({ code: "not_found" }));
  expect(bad.text()).toContain(en("error.not_found"));
});
