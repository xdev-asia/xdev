import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { CodeEditor } from "./CodeEditor";
import { FileView } from "./FileView";
import { fileTabs } from "./fileTabs";

const hooks = vi.hoisted(() => ({ active: false, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
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
const W = "C:/wt/a";

const draw = (api: ReturnType<typeof createMockApi>) => {
  hooks.active = true;
  hooks.effects = [];
  try { return nodes(FileView({ api, worktree: W, rel: "a.ts" })); } finally { hooks.active = false; }
};
const ready = (over: Partial<Parameters<typeof fileTabs.loaded>[2]> = {}) => {
  fileTabs.open(W, "a.ts");
  fileTabs.loaded(W, "a.ts", { text: "one", kind: "text", hash: "h1", eol: "lf", size: 3, ...over } as never);
};

beforeEach(() => fileTabs.reset());
afterEach(() => fileTabs.reset());

it("shows the editor for a text file and writes edits into the store", () => {
  ready();
  const editor = draw(createMockApi({})).find((n) => n.type === CodeEditor)!;
  expect(editor.props.value).toBe("one");
  editor.props.onChange("two");
  expect(fileTabs.get(W, "a.ts")!.text).toBe("two");
});

it("the editor's save writes with the loaded hash", async () => {
  const api = createMockApi({});
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h2" });
  ready();
  fileTabs.edit(W, "a.ts", "two");
  draw(api).find((n) => n.type === CodeEditor)!.props.onSave();
  await tick();
  expect(write).toHaveBeenCalledWith(W, "a.ts", "two", "lf", "h1");
});

it("a conflict shows the bar; Reload takes the disk text, Overwrite writes over it", async () => {
  const api = createMockApi({});
  ready();
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.conflict(W, "a.ts", "disk9");
  const bar = () => draw(api).find((n) => n.props.className === "file-conflict")!;
  expect(nodes(bar()).some((n) => n.props.children === en("files.conflict.body"))).toBe(true);
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h3" });
  const buttons = () => nodes(bar()).filter((n) => n.props.onClick);
  buttons()[1].props.onClick();
  await tick();
  expect(write).toHaveBeenCalledWith(W, "a.ts", "mine", "lf", "disk9");
  expect(fileTabs.get(W, "a.ts")!.conflict).toBeNull();

  fileTabs.edit(W, "a.ts", "mine2");
  fileTabs.conflict(W, "a.ts", "disk10");
  vi.spyOn(api, "fileRead").mockResolvedValue({ text: "from disk", kind: "text", hash: "disk10", eol: "lf", size: 9 } as never);
  buttons()[0].props.onClick();
  await tick();
  expect(fileTabs.get(W, "a.ts")).toMatchObject({ text: "from disk", saved: "from disk", conflict: null });
});

it("a binary or too large file has no editor, only Reveal in File Manager", async () => {
  for (const kind of ["binary", "tooLarge"] as const) {
    fileTabs.reset();
    const api = createMockApi({});
    const reveal = vi.spyOn(api, "fileReveal").mockResolvedValue(undefined);
    ready({ kind, text: null } as never);
    const all = draw(api);
    expect(all.find((n) => n.type === CodeEditor)).toBeUndefined();
    all.find((n) => n.type === "button" && n.props.children === en("files.menu.reveal"))!.props.onClick();
    expect(reveal).toHaveBeenCalledWith(W, "a.ts");
  }
});

it("reads the file once while it is loading", () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "fileRead");
  fileTabs.open(W, "a.ts");
  const all = draw(api);
  expect(all.some((n) => n.props.children === en("files.loading"))).toBe(true);
  hooks.effects.forEach((e) => e());
  expect(read).toHaveBeenCalledWith(W, "a.ts");
});
