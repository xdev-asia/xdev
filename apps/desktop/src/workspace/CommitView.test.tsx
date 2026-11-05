import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Api, CommitFiles } from "@/api";
import { DiffView } from "@/components/DiffView";
import { translate } from "@/i18n";
import { CommitView, CommitFileDiff } from "./CommitView";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  return {
    ...react,
    useState: (initial: any) => {
      if (!hooks.active) return react.useState(initial);
      const { index, values } = slot(initial);
      return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// The diff editor needs a DOM; the tests look at the props it is given.
vi.mock("@/components/DiffView", () => ({ DiffView: () => null }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const WT = "/demo/wt/oak";
const ID = "abcdef1234567";

const FILES: CommitFiles = {
  id: ID,
  parent: "1234567890abc",
  files: [
    { path: "src/app.ts", oldPath: null, status: "modified", added: 2, removed: 1 },
    { path: "README.md", oldPath: null, status: "added", added: 3, removed: 0 },
    { path: "old.txt", oldPath: null, status: "deleted", added: 0, removed: 4 },
  ],
};

function stub(over: Record<string, unknown> = {}) {
  return {
    worktreeCommitFiles: vi.fn(async () => FILES),
    worktreeCommitFile: vi.fn(async () => ({ old: "a", new: "b", skip: null })),
    ...over,
  } as unknown as Api;
}

type Ask = { id: string; file: string | null; seq: number };

function mount(api: Api, first: Ask) {
  let commit = first;
  const state = { values: [] as unknown[] };
  const draw = () => {
    hooks.values = state.values;
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.active = true;
    try { return CommitView({ api, worktree: WT, commit }); } finally { hooks.active = false; }
  };
  let view = draw();
  return {
    flush: async () => {
      for (const effect of hooks.effects) effect();
      await tick();
      view = draw();
    },
    redraw: () => (view = draw()),
    all: () => nodes(view),
    html: () => renderToStaticMarkup(view),
    rows: () => nodes(view).filter((n) => n.props["data-file"] !== undefined),
    ask: (next: Ask) => { commit = next; view = draw(); },
  };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

it("lists the files with their letters and names the parent it compares with", async () => {
  const api = stub();
  const v = mount(api, { id: ID, file: null, seq: 1 });
  expect(v.html()).toContain(en("commitView.loading"));
  await v.flush();
  expect(api.worktreeCommitFiles).toHaveBeenCalledWith(WT, ID);
  const html = v.html();
  expect(html).toContain(en("commitView.title", { id: "abcdef1" }));
  expect(html).toContain(en("commitView.base", { base: "1234567" }));
  expect(v.rows().map((r) => r.props["data-file"])).toEqual(["src/app.ts", "README.md", "old.txt"]);
  expect(html).toContain(">M<");
  expect(html).toContain(">A<");
  expect(html).toContain(">D<");
});

it("opens every file when asked for all changes together", async () => {
  const v = mount(stub(), { id: ID, file: null, seq: 1 });
  await v.flush();
  expect(v.rows().map((r) => r.props["aria-expanded"])).toEqual([true, true, true]);
  expect(v.all().filter((n) => n.type === CommitFileDiff).map((n) => n.props.file)).toEqual(["src/app.ts", "README.md", "old.txt"]);
});

it("opens only the asked file, and a click toggles another", async () => {
  const v = mount(stub(), { id: ID, file: "README.md", seq: 1 });
  await v.flush();
  expect(v.rows().map((r) => r.props["aria-expanded"])).toEqual([false, true, false]);
  v.rows()[0].props.onClick();
  v.redraw();
  expect(v.rows().map((r) => r.props["aria-expanded"])).toEqual([true, true, false]);
  v.rows()[1].props.onClick();
  v.redraw();
  expect(v.rows().map((r) => r.props["aria-expanded"])).toEqual([true, false, false]);
});

it("points the open files at the new ask when its seq changes", async () => {
  const v = mount(stub(), { id: ID, file: "README.md", seq: 1 });
  await v.flush();
  v.rows()[0].props.onClick();
  v.ask({ id: ID, file: "old.txt", seq: 2 });
  await v.flush();
  expect(v.rows().map((r) => r.props["aria-expanded"])).toEqual([false, false, true]);
});

it("reads a root commit against the empty tree", async () => {
  const api = stub({ worktreeCommitFiles: vi.fn(async () => ({ ...FILES, parent: null })) });
  const v = mount(api, { id: ID, file: null, seq: 1 });
  await v.flush();
  expect(v.html()).toContain(en("commitView.base", { base: en("commitView.emptyTree") }));
  expect(en("commitView.emptyTree")).toBe("empty tree");
});

it("says so when a commit has no file changes", async () => {
  const v = mount(stub({ worktreeCommitFiles: vi.fn(async () => ({ ...FILES, files: [] })) }), { id: ID, file: null, seq: 1 });
  await v.flush();
  expect(v.html()).toContain(en("commitView.none"));
});

it("shows an unresolved commit and any other failure as text", async () => {
  const bad = mount(stub({ worktreeCommitFiles: vi.fn(async () => { throw { code: "git" }; }) }), { id: ID, file: null, seq: 1 });
  await bad.flush();
  expect(bad.html()).toContain(en("commitView.unresolved", { id: "abcdef1" }));
  const other = mount(stub({ worktreeCommitFiles: vi.fn(async () => { throw { code: "io" }; }) }), { id: ID, file: null, seq: 1 });
  await other.flush();
  expect(other.html()).toContain(en("commitView.failed"));
});

function diffOf(api: Api, file = "src/app.ts") {
  const state = { values: [] as unknown[] };
  const draw = () => {
    hooks.values = state.values;
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.active = true;
    try { return CommitFileDiff({ api, worktree: WT, id: ID, file }); } finally { hooks.active = false; }
  };
  let view = draw();
  return {
    flush: async () => { for (const effect of hooks.effects) effect(); await tick(); view = draw(); },
    html: () => renderToStaticMarkup(view),
    all: () => nodes(view),
  };
}

it("reads one file's two sides and hands them to the diff", async () => {
  const api = stub();
  const d = diffOf(api);
  expect(d.html()).toContain(en("commitView.fileLoading"));
  await d.flush();
  expect(api.worktreeCommitFile).toHaveBeenCalledWith(WT, ID, "src/app.ts");
  expect(d.all().find((n) => n.type === DiffView)!.props).toMatchObject({ base: "a", current: "b" });
});

it("says why a file has no diff", async () => {
  const bin = diffOf(stub({ worktreeCommitFile: vi.fn(async () => ({ old: null, new: null, skip: "binary" })) }));
  await bin.flush();
  expect(bin.html()).toContain(en("workspace.diff.binary"));
  const big = diffOf(stub({ worktreeCommitFile: vi.fn(async () => ({ old: null, new: null, skip: "too_large" })) }));
  await big.flush();
  expect(big.html()).toContain(en("workspace.diff.tooLarge"));
  const bad = diffOf(stub({ worktreeCommitFile: vi.fn(async () => { throw { code: "io" }; }) }));
  await bad.flush();
  expect(bad.html()).toContain(en("commitView.failed"));
});
