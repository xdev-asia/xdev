import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { QuickOpenDialog, resetFileListCache } from "./QuickOpenDialog";
import { RecentFiles } from "./recentFiles";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useMemo: (fn: any, deps: any) => (hooks.active ? fn() : react.useMemo(fn, deps)),
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
const WT = "/demo/wt/xdev-oak";

function storage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: (k) => data.get(k) ?? null, key: () => null, removeItem: (k) => void data.delete(k), setItem: (k, v) => void data.set(k, v) };
}

function dialog(api: Api, over: { worktree?: string | null; recent?: RecentFiles } = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const recent = over.recent ?? new RecentFiles(storage());
  const props = { open: true, api, worktree: over.worktree === undefined ? WT : over.worktree, recent, onOpen, onClose };
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return QuickOpenDialog(props) as Node; } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  hooks.effects.slice(before).forEach((e) => e());
  const all = () => nodes(draw());
  const input = () => all().find((n) => n.props.className === "pal-input")!;
  const rows = () => all().filter((n) => n.props.role === "option");
  const names = () => rows().map((r) => nodes(r).find((n) => n.props.className === "pal-title-text")!).map((n) => nodes(n).find((c) => c.props.text !== undefined)!.props.text as string);
  const type = (text: string) => input().props.onChange({ target: { value: text } });
  const key = (init: Record<string, unknown>) => {
    const e = { key: "", ctrlKey: false, metaKey: false, keyCode: 0, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), ...init };
    draw().props.onKeyDown(e);
  };
  return { onOpen, onClose, all, rows, names, type, key, draw };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; resetFileListCache(); });
afterEach(() => { vi.restoreAllMocks(); });

it("loads the list once, filters by typing and opens the selected file", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "filesList");
  const d = dialog(api);
  await tick();
  expect(list).toHaveBeenCalledWith(WT);
  expect(d.names().length).toBeGreaterThan(2);
  d.type("app");
  expect(d.names()[0]).toBe("App.tsx");
  d.key({ key: "Enter" });
  expect(d.onOpen).toHaveBeenCalledWith("src/App.tsx", { line: undefined, side: false });
  expect(d.onClose).toHaveBeenCalled();
});

it("a :n suffix opens at that line, Ctrl+Enter opens to the side", async () => {
  const d = dialog(createMockApi({}));
  await tick();
  d.type("App.tsx:12");
  d.key({ key: "Enter", ctrlKey: true });
  expect(d.onOpen).toHaveBeenCalledWith("src/App.tsx", { line: 12, side: true });
});

it("a path:line:col and an absolute path inside the worktree open that file at the place", async () => {
  const d = dialog(createMockApi({}));
  await tick();
  d.type(`${WT}/src/App.tsx:3:2`);
  expect(d.names()[0]).toBe("App.tsx");
  d.key({ key: "Enter" });
  expect(d.onOpen).toHaveBeenCalledWith("src/App.tsx", { line: 3, column: 2, side: false });
  const e = dialog(createMockApi({}));
  await tick();
  e.type("src/App.tsx:5:1");
  e.key({ key: "Enter", ctrlKey: true });
  expect(e.onOpen).toHaveBeenCalledWith("src/App.tsx", { line: 5, column: 1, side: true });
});

it("an absolute path outside the worktree matches nothing", async () => {
  const d = dialog(createMockApi({}));
  await tick();
  d.type("/elsewhere/src/App.tsx:3");
  expect(d.names()).toEqual([]);
  d.key({ key: "Enter" });
  expect(d.onOpen).not.toHaveBeenCalled();
});

it("arrows move the selection and Escape closes through onCancel", async () => {
  const d = dialog(createMockApi({}));
  await tick();
  d.type("a");
  const first = d.names();
  d.key({ key: "ArrowDown" });
  d.key({ key: "Enter" });
  expect(d.onOpen.mock.calls[0][0].endsWith(first[1]) || first.length === 1).toBe(true);
  const e = { preventDefault: vi.fn() };
  d.draw().props.onCancel(e);
  expect(e.preventDefault).toHaveBeenCalled();
  expect(d.onClose).toHaveBeenCalledTimes(2);
});

it("lists recent files first for an empty query and caches the list for 30 s", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "filesList");
  const recent = new RecentFiles(storage());
  recent.touch(WT, "package.json");
  const d = dialog(api, { recent });
  await tick();
  expect(d.names()[0]).toBe("package.json");
  dialog(api, { recent });
  await tick();
  expect(list).toHaveBeenCalledTimes(1);
});

it("without a worktree it never lists", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "filesList");
  dialog(api, { worktree: null });
  await tick();
  expect(list).not.toHaveBeenCalled();
});
