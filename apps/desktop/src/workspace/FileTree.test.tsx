import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type DirListing, type WorktreeChange } from "../api";
import { translate } from "../i18n";
import { FileTree } from "./FileTree";

// Hooks are stubbed only while a component under test is called; each harness keeps its own.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  const state = (initial: unknown) => {
    const { index, values } = slot(initial);
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
  };
});
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const CHANGES: WorktreeChange[] = [
  { path: "docs/old-notes.md", kind: "deleted" },
  { path: "src/session.ts", kind: "modified" },
  { path: "src/status.ts", kind: "added" },
];

// Calls `render` with its own hook values; the effects of the first draw run once, as on mount.
// `again` draws with new props and runs the effects, as a re-render with changed deps does.
function mount(render: (changes: WorktreeChange[]) => unknown, first: WorktreeChange[]) {
  const values: unknown[] = [];
  const draw = (changes: WorktreeChange[]) => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(changes); } finally { hooks.active = false; }
  };
  let current = first;
  const run = (changes: WorktreeChange[]) => {
    const before = hooks.effects.length;
    current = changes;
    draw(changes);
    hooks.effects.slice(before).forEach((effect) => effect());
  };
  run(first);
  return { all: () => nodes(draw(current)), html: () => renderToStaticMarkup(draw(current) as ReactElement), again: run };
}

function tree(api: Api, changes: WorktreeChange[] = CHANGES) {
  const onOpen = vi.fn();
  const view = mount((list) => FileTree({ api, worktree: OAK, changes: list, onOpen }), changes);
  const rows = () => view.all().filter((n) => n.props.role === "treeitem");
  const label = (r: Node) => nodes(r).find((n) => n.props.className === "ws-tree-name")?.props.children;
  const row = (name: string) => rows().find((r) => label(r) === name)!;
  const mark = (name: string) => nodes(row(name)).find((n) => n.props.className === "ws-tree-mark")?.props;
  return { ...view, onOpen, rows, row, label, mark };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => { vi.restoreAllMocks(); });

it("expands a folder on click and lists it once", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  // Folders first, then files, as the listing gives them.
  expect(view.rows().map(view.label)).toEqual(["docs", "src", "package.json", "README.md"]);
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith(OAK, "");

  view.row("src").props.onClick();
  await tick();
  expect(view.row("src").props["aria-expanded"]).toBe(true);
  expect(view.row("App.tsx").props["aria-level"]).toBe(2);
  expect(list).toHaveBeenCalledWith(OAK, "src");

  // Closing and opening again reads nothing more.
  view.row("src").props.onClick();
  expect(view.rows().map(view.label)).not.toContain("App.tsx");
  view.row("src").props.onClick();
  await tick();
  expect(view.rows().map(view.label)).toContain("App.tsx");
  expect(list.mock.calls.filter(([, dir]) => dir === "src")).toHaveLength(1);
  expect(list).toHaveBeenCalledTimes(2);
});

it("marks changed files M and new files A", async () => {
  const view = tree(createMockApi({}));
  await tick();
  view.row("src").props.onClick();
  await tick();
  expect(view.mark("session.ts")?.children).toBe("M");
  expect(view.mark("status.ts")?.children).toBe("A");
  expect(view.mark("status.ts")?.["data-kind"]).toBe("added");
  expect(view.mark("session.ts")?.title).toBe(en("changes.kind.modified"));
  expect(view.mark("App.tsx")).toBeUndefined();
  // A folder holding changes carries a dot; a clean one does not.
  const dot = (name: string) => nodes(view.row(name)).some((n) => n.props.className === "ws-tree-dot");
  expect(dot("src")).toBe(true);
  expect(dot("docs")).toBe(true);
  expect(dot("lib")).toBe(false);
  // The deleted file is not on disk, so the tree never shows it.
  view.row("docs").props.onClick();
  await tick();
  expect(view.html()).not.toContain("old-notes");
});

it("opening a changed file calls onOpen", async () => {
  const view = tree(createMockApi({}));
  await tick();
  view.row("src").props.onClick();
  await tick();
  view.row("status.ts").props.onClick();
  expect(view.onOpen).toHaveBeenCalledTimes(1);
  expect(view.onOpen).toHaveBeenCalledWith("src/status.ts");
  // A file with no change has no diff to open.
  expect(view.row("App.tsx").type).toBe("div");
  expect(view.row("App.tsx").props.onClick).toBeUndefined();
  expect(view.onOpen).toHaveBeenCalledTimes(1);
});

it("shows … when truncated", async () => {
  const api = createMockApi({});
  const cut: DirListing = { entries: [{ name: "a", dir: false }, { name: "b", dir: false }], truncated: true };
  vi.spyOn(api, "worktreeListDir").mockResolvedValue(cut);
  const view = tree(api, []);
  await tick();
  const more = view.all().find((n) => n.props.className === "ws-tree-note")!;
  expect(more.props.children).toBe("…");
  expect(more.props.title).toBe(en("workspace.files.truncated"));
  expect(view.rows().map((r) => r.props.className)).toEqual(["ws-tree-row", "ws-tree-row", "ws-tree-note"]);
});

it("reads the shown folders again when the changes list is new", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  view.row("src").props.onClick();
  await tick();
  expect(list).toHaveBeenCalledTimes(2);

  view.again([...CHANGES]);
  await tick();
  expect(list.mock.calls.slice(2).map(([, dir]) => dir).sort()).toEqual(["", "src"]);
  // The folder stays open and shown through the refresh.
  expect(view.rows().map(view.label)).toContain("App.tsx");
});

it("says why a folder could not be read", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeListDir").mockRejectedValue({ code: "bad_path" });
  const view = tree(api, []);
  await tick();
  const note = view.all().find((n) => n.props.className === "ws-tree-note")!;
  expect(note.props.children).toBe(en("workspace.files.error"));
});
