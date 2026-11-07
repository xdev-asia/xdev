import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { BasePicker } from "./BasePicker";
import { FileDiff } from "./FileDiff";
import { Checkbox, SearchInput, SplitHandle, TreeView } from "@xdev-asia/ui";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { ReviewView } from "./ReviewView";
import { touchChanges } from "@/workspace/changesBus";
import { LOCAL_KEY, VIEW_KEY } from "./viewOptions";

// Hooks are stubbed only while a component under test is called.
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
    // The profile store is outside what these tests render; its context keeps the default.
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const START = "5555555555555555555555555555555555555555";
// Calls `render` with its own hook values; the first draw's effects run once, as on mount.
function mount(render: () => unknown) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  return { draw, all, html, find, cleanups };
}

const key = (extra: object = {}) => ({ key: "F7", shiftKey: false, preventDefault: vi.fn(), ...extra });
const PATHS = ["docs/old-notes.md", "src/session.ts", "src/status.ts"];

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function review(api: Api, extra: Partial<Parameters<typeof ReviewView>[0]> = {}) {
  const view = mount(() => ReviewView({ api, worktree: OAK, ...extra }));
  const diffs = () => view.all().filter((n) => n.type === FileDiff);
  const diff = (path: string) => diffs().find((n) => n.props.file.path === path)!;
  const root = () => view.all()[0];
  const picker = () => view.all().find((n) => n.type === BasePicker);
  return { ...view, diffs, diff, root, picker };
}

it("reads the review and draws one section per file against the start", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeReview");
  const v = review(api);
  await tick();
  expect(read).toHaveBeenCalledWith(OAK, null);
  expect(v.diffs().map((n) => n.props.file.path)).toEqual(PATHS);
  expect(v.diff("src/session.ts").props).toMatchObject({ api, worktree: OAK, base: START, open: true });
  expect(v.picker()!.props).toMatchObject({ worktree: OAK, baseRef: "main" });
});

it("starts closed past thirty files", async () => {
  const api = createMockApi({});
  const files = Array.from({ length: 31 }, (_, i) => ({ path: `f${i}.ts`, kind: "modified" as const, staged: false, unstaged: true }));
  vi.spyOn(api, "worktreeReview").mockResolvedValue({ base: { kind: "start", name: null, id: START }, branch: "oak", baseRef: "main", headOid: null, files });
  const v = review(api);
  await tick();
  expect(v.diffs().every((n) => n.props.open === false)).toBe(true);
  v.diff("f3.ts").props.onToggle("f3.ts");
  expect(v.diff("f3.ts").props.open).toBe(true);
  expect(v.diff("f4.ts").props.open).toBe(false);
});

it("a reveal opens the file and scrolls to it", async () => {
  const api = createMockApi({});
  const v = review(api, { reveal: { file: "src/status.ts", seq: 4 } });
  await tick();
  expect(v.diff("src/status.ts").props).toMatchObject({ open: true, revealSeq: 4 });
  expect(v.diff("src/session.ts").props.revealSeq).toBe(0);
});

it("a reveal with a base reads the review against it, once per reveal", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeReview");
  review(api, { reveal: { file: "src/status.ts", seq: 2, base: "main" } });
  await tick();
  expect(read.mock.calls).toEqual([
    [OAK, null],
    [OAK, "main"],
  ]);
  // A focus reads again and keeps the base the reveal set.
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(read).toHaveBeenLastCalledWith(OAK, "main");
});

it("switching the base reads again and a bad base keeps the view", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeReview");
  const v = review(api);
  await tick();
  v.picker()!.props.onPick("develop");
  await tick();
  expect(read).toHaveBeenLastCalledWith(OAK, "develop");
  expect(v.picker()!.props.base).toMatchObject({ kind: "ref", name: "develop" });

  v.picker()!.props.onPick("no-such-branch");
  await tick();
  expect(v.picker()!.props.base).toMatchObject({ name: "develop" });
  expect(v.html()).toContain(en("error.bad_ref"));
  expect(v.diffs()).toHaveLength(3);

  // A later read keeps the base that worked.
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(read).toHaveBeenLastCalledWith(OAK, "develop");
});

it("F7 and shift+F7 walk the changes across files", async () => {
  const api = createMockApi({});
  const v = review(api);
  await tick();
  const goTo = Object.fromEntries(PATHS.map((p) => [p, vi.fn()]));
  for (const [path, n] of [["docs/old-notes.md", 1], ["src/session.ts", 2], ["src/status.ts", 0]] as const) {
    v.diff(path).props.register(path, { chunks: () => n, goTo: goTo[path] });
    v.diff(path).props.onChunks(path, n);
  }
  v.draw();
  const press = (extra: object = {}) => { const e = key(extra); v.root().props.onKeyDown(e); return e; };
  expect(press().preventDefault).toHaveBeenCalled();
  expect(goTo["docs/old-notes.md"]).toHaveBeenLastCalledWith(0);
  press();
  expect(goTo["src/session.ts"]).toHaveBeenLastCalledWith(0);
  press();
  expect(goTo["src/session.ts"]).toHaveBeenLastCalledWith(1);
  press();
  expect(goTo["docs/old-notes.md"]).toHaveBeenCalledTimes(2);
  press({ shiftKey: true });
  expect(goTo["src/session.ts"]).toHaveBeenLastCalledWith(1);
  expect(press({ key: "a" }).preventDefault).not.toHaveBeenCalled();
});

it("stages and unstages one file, then reads again", async () => {
  const api = createMockApi({});
  const stage = vi.spyOn(api, "worktreeStage");
  const read = vi.spyOn(api, "worktreeReview");
  const v = review(api);
  await tick();
  v.diff("src/session.ts").props.onStage(v.diff("src/session.ts").props.file, true);
  await tick();
  expect(stage).toHaveBeenLastCalledWith(OAK, ["src/session.ts"], true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(v.diff("src/session.ts").props.file).toMatchObject({ staged: true, unstaged: false });
  v.diff("src/session.ts").props.onStage(v.diff("src/session.ts").props.file, false);
  await tick();
  expect(stage).toHaveBeenLastCalledWith(OAK, ["src/session.ts"], false);
});

it("reads again when the changes panel stages or discards, and stops once it unmounts", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeReview");
  const v = review(api);
  await tick();
  expect(read).toHaveBeenCalledTimes(1);
  touchChanges(OAK);
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
  v.cleanups.forEach((stop) => typeof stop === "function" && stop());
  touchChanges(OAK);
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
});

function memoryStorage(initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, x: string) => void saved.set(k, x),
    removeItem: (k: string) => void saved.delete(k),
  });
  return saved;
}
const saveButton = (v: ReturnType<typeof review>) => v.all().find((n) => n.props["data-act"] === "save-default")!;

it("starts from the diff settings; a change stays in this view until Save as default", async () => {
  const saved = memoryStorage();
  const api = createMockApi({});
  await api.diffSettingsPut({ defaultView: "split", ignoreWhitespace: true, collapseUnchanged: false, wordWrap: true, fileTree: true });
  const v = review(api);
  await tick();
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ layout: "split", ignoreWhitespace: true, collapse: false, wrap: true });
  expect(saveButton(v).props.disabled).toBe(true);

  // A toggle changes this view only: no settings write, nothing in localStorage.
  const put = vi.spyOn(api, "diffSettingsPut");
  v.all().find((n) => n.type === "button" && n.props["aria-pressed"] === false)!.props.onClick();
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ layout: "inline" });
  expect(put).not.toHaveBeenCalled();
  expect([...saved.keys()]).toEqual([]);
  // A view opened now still starts from the settings.
  const other = review(api);
  await tick();
  expect(other.diff("src/session.ts").props.opts).toMatchObject({ layout: "split" });

  expect(saveButton(v).props.disabled).toBe(false);
  saveButton(v).props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith({ defaultView: "inline", ignoreWhitespace: true, collapseUnchanged: false, wordWrap: true, fileTree: true });
  expect(await api.diffSettings()).toMatchObject({ defaultView: "inline" });
  expect(saveButton(v).props.disabled).toBe(true);
  const again = review(api);
  await tick();
  expect(again.diff("src/session.ts").props.opts).toMatchObject({ layout: "inline", ignoreWhitespace: true });
});

it("a Line authors checkbox turns the gutter off for this view and keeps the choice", async () => {
  const saved = memoryStorage();
  const api = createMockApi({});
  const v = review(api);
  await tick();
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ attribution: true });
  const box = v.all().find((n) => n.type === Checkbox && n.props.label === en("review.opt.attribution"))!;
  expect(box.props).toMatchObject({ checked: true });
  box.props.onChange();
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ attribution: false });
  expect(JSON.parse(saved.get(LOCAL_KEY)!)).toMatchObject({ attribution: false });
  expect(v.html()).toContain("Line authors");
  expect(v.html()).not.toContain("btn-primary");
});

it("moves the options an older version kept in localStorage into the settings, once", async () => {
  const saved = memoryStorage({ [VIEW_KEY]: JSON.stringify({ layout: "split", ignoreWhitespace: true, collapse: true, lineNumbers: false, wrap: true, listWidth: 300 }) });
  const api = createMockApi({});
  const put = vi.spyOn(api, "diffSettingsPut");
  const v = review(api);
  await tick();
  expect(put).toHaveBeenCalledOnce();
  expect(await api.diffSettings()).toEqual({ defaultView: "split", ignoreWhitespace: true, collapseUnchanged: true, wordWrap: true, fileTree: false });
  expect(saved.has(VIEW_KEY)).toBe(false);
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ layout: "split", lineNumbers: false, listWidth: 300 });
  const next = review(api);
  await tick();
  expect(put).toHaveBeenCalledOnce();
  expect(next.diff("src/session.ts").props.opts).toMatchObject({ layout: "split", wrap: true });
});

it("the file list resizes by keyboard within its limits", async () => {
  const api = createMockApi({});
  const v = review(api);
  await tick();
  const bar = () => v.all().find((n) => n.type === SplitHandle)!;
  expect(bar().props.value).toBe(240);
  bar().props.onResize(256);
  expect(bar().props.value).toBe(256);
  bar().props.onResize(10);
  expect(bar().props.value).toBe(160);
  bar().props.onResize(9999);
  expect(bar().props.value).toBe(480);
});

it("shows a problem when the review cannot be read", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeReview").mockRejectedValue({ code: "worktree_unknown" });
  const v = review(api);
  await tick();
  expect(v.html()).toContain(en("error.worktree_unknown"));
  expect(v.diffs()).toHaveLength(0);
});

it("the base picker lists the start, the base branch and the others", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeBranches");
  const onPick = vi.fn();
  const base = { kind: "start" as const, name: null, id: START };
  const p = mount(() => BasePicker({ api, worktree: OAK, base, baseRef: "main", onPick }));
  expect(list).not.toHaveBeenCalled();
  p.find((n) => n.type === "button" && n.props["aria-haspopup"] === "listbox")!.props.onClick();
  // The branch list is read when the menu first opens; this draw schedules that effect.
  p.draw();
  hooks.effects.at(-1)?.();
  await tick();
  const names = () => p.all().filter((n) => n.props.role === "option").map((n) => n.props.children);
  expect(names()).toEqual([en("review.base.start"), "main", "develop", "origin/main"]);
  p.find((n) => n.props.role === "option" && n.props.children === "develop")!.props.onClick();
  expect(onPick).toHaveBeenCalledWith("develop");
  // Choosing closes the menu; open it again.
  p.find((n) => n.props["aria-haspopup"] === "listbox")!.props.onClick();
  p.find((n) => n.props.role === "option" && n.props.children === en("review.base.start"))!.props.onClick();
  expect(onPick).toHaveBeenLastCalledWith(null);
});

it("the base picker takes a typed commit and ignores an empty one", async () => {
  const api = createMockApi({});
  const onPick = vi.fn();
  const base = { kind: "ref" as const, name: "main", id: START };
  const p = mount(() => BasePicker({ api, worktree: OAK, base, baseRef: "main", onPick }));
  expect(p.html()).toContain("main");
  p.find((n) => n.props["aria-haspopup"] === "listbox")!.props.onClick();
  const submit = () => p.find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  submit();
  expect(onPick).not.toHaveBeenCalled();
  p.find((n) => n.type === "input")!.props.onChange({ target: { value: "  abc1234 " } });
  submit();
  expect(onPick).toHaveBeenCalledWith("abc1234");
});

const manyFiles = (api: Api) => {
  const files = Array.from({ length: 31 }, (_, i) => ({ path: `f${i}.ts`, kind: "modified" as const, staged: false, unstaged: true }));
  vi.spyOn(api, "worktreeReview").mockResolvedValue({ base: { kind: "start", name: null, id: START }, branch: "oak", baseRef: "main", headOid: null, files });
};

it("F7 opens a closed file and goes to its first change once it is drawn", async () => {
  const api = createMockApi({});
  manyFiles(api);
  const v = review(api);
  await tick();
  expect(v.diff("f0.ts").props.open).toBe(false);
  v.root().props.onKeyDown(key());
  expect(v.diff("f0.ts").props.open).toBe(true);
  const goTo = vi.fn();
  v.diff("f0.ts").props.register("f0.ts", { chunks: () => 2, goTo, goToLine: vi.fn() });
  expect(goTo).toHaveBeenCalledWith(0);
});

it("a note in the list scrolls to its line after a closed file is drawn", async () => {
  const api = createMockApi({});
  manyFiles(api);
  const v = review(api);
  await tick();
  v.diff("f2.ts").props.handlers.add({ startLine: 7, line: 8, anchor: "x" }, "fix");
  await tick();
  v.find((n) => n.props["aria-haspopup"] === "dialog")!.props.onClick();
  const menu = v.find((n) => n.props.role === "dialog")!;
  nodes(menu.props.children).find((n) => n.type === "button")!.props.onClick();
  expect(v.diff("f2.ts").props.open).toBe(true);
  const goToLine = vi.fn();
  v.diff("f2.ts").props.register("f2.ts", { chunks: () => 1, goTo: vi.fn(), goToLine });
  expect(goToLine).toHaveBeenCalledWith(8);
});

it("a file both staged and unstaged offers Stage and Unstage", () => {
  const props = (file: object) => ({ api: createMockApi({}), worktree: OAK, base: START, file, opts: { layout: "inline" }, open: false, rev: 0, revealSeq: 0, busy: false, onToggle() {}, onStage() {}, register() {}, onChunks() {}, notes: [], handlers: {}, onRead() {} }) as any;
  const labels = (file: object) => mount(() => FileDiff(props(file))).html();
  const both = labels({ path: "a.ts", kind: "modified", staged: true, unstaged: true });
  expect(both).toContain(en("review.stage"));
  expect(both).toContain(en("review.unstage"));
  const staged = labels({ path: "a.ts", kind: "modified", staged: true, unstaged: false });
  expect(staged).toContain(en("review.unstage"));
  expect(staged).not.toContain(`>${en("review.stage")}<`);
  const plain = labels({ path: "a.ts", kind: "modified", staged: false, unstaged: true });
  expect(plain).toContain(`>${en("review.stage")}<`);
  expect(plain).not.toContain(en("review.unstage"));
});

it("draws the file tree when the setting asks for it, folds a folder and saves the choice", async () => {
  memoryStorage();
  const api = createMockApi({});
  await api.diffSettingsPut({ defaultView: "inline", ignoreWhitespace: false, collapseUnchanged: true, wordWrap: false, fileTree: true });
  const v = review(api);
  await tick();
  const tree = v.all().find((n) => n.type === TreeView)!;
  expect(tree).toBeDefined();
  expect(tree.props.rows.some((r: { kind: string }) => r.kind === "dir")).toBe(true);
  expect(v.all().some((n) => n.props.className === "rv-list-item")).toBe(false);

  // Back to the list: the change is local until Save as default, which writes fileTree.
  const put = vi.spyOn(api, "diffSettingsPut");
  v.all().find((n) => n.props["data-view"] === "list")!.props.onClick();
  expect(v.all().some((n) => n.type === TreeView)).toBe(false);
  expect(put).not.toHaveBeenCalled();
  expect(saveButton(v).props.disabled).toBe(false);
  saveButton(v).props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ fileTree: false }));
});

it("filters the file list by path, says when nothing matches and clears", async () => {
  memoryStorage();
  const api = createMockApi({});
  const v = review(api);
  await tick();
  const input = () => v.all().find((n) => n.type === SearchInput)!;
  const items = () => v.all().filter((n) => n.props.className === "rv-list-item").map((n) => n.props["data-path"]);
  expect(items()).toEqual(PATHS);
  input().props.onChange({ target: { value: "SESSION" } });
  expect(items()).toEqual(["src/session.ts"]);
  input().props.onChange({ target: { value: "zzz" } });
  expect(items()).toEqual([]);
  expect(v.html()).toContain(en("review.filter.none"));
  input().props.onClear();
  expect(items()).toEqual(PATHS);
});

it("the tree follows the filter and marks the file that was clicked", async () => {
  memoryStorage();
  const api = createMockApi({});
  await api.diffSettingsPut({ defaultView: "inline", ignoreWhitespace: false, collapseUnchanged: true, wordWrap: false, fileTree: true });
  const v = review(api);
  await tick();
  const tree = () => v.all().find((n) => n.type === TreeView)!;
  expect(tree().props.selected).toBeUndefined();
  tree().props.onOpen("src/status.ts");
  expect(tree().props.selected).toBe("src/status.ts");
  v.all().find((n) => n.type === SearchInput)!.props.onChange({ target: { value: "notes" } });
  expect(tree().props.rows.filter((r: { kind: string }) => r.kind === "file").map((r: { id: string }) => r.id)).toEqual(["docs/old-notes.md"]);
});

const PR = { number: 9, url: "https://example.test/pull/9", state: "open" as const, title: "Oak", base: "main", head: "oak" };
const withPr = (viewed?: string[]) =>
  createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [OAK]: PR }, prViewed: viewed ? { [OAK]: viewed } : {} } });
const viewedBox = (v: ReturnType<typeof review>, path: string) => nodes(v.diff(path).props.extra).find((n) => n.type === Checkbox);

it("with an open PR each file offers Viewed; a viewed file starts folded", async () => {
  const api = withPr(["src/status.ts"]);
  const read = vi.spyOn(api, "worktreePrViewed");
  const v = review(api);
  await tick();
  expect(read).toHaveBeenCalledWith(OAK, 9);
  expect(viewedBox(v, "src/status.ts")!.props).toMatchObject({ label: en("review.viewed"), checked: true });
  expect(viewedBox(v, "src/session.ts")!.props.checked).toBe(false);
  expect(v.diff("src/status.ts").props.open).toBe(false);
  expect(v.diff("src/session.ts").props.open).toBe(true);
});

it("checking Viewed marks the file on the PR and folds it; unchecking opens it again", async () => {
  const api = withPr([]);
  const mark = vi.spyOn(api, "worktreePrFileViewed");
  const v = review(api);
  await tick();
  viewedBox(v, "src/session.ts")!.props.onChange({ target: { checked: true } });
  expect(viewedBox(v, "src/session.ts")!.props.checked).toBe(true);
  expect(v.diff("src/session.ts").props.open).toBe(false);
  await tick();
  expect(mark).toHaveBeenLastCalledWith(OAK, "PR_mock9", "src/session.ts", true);
  viewedBox(v, "src/session.ts")!.props.onChange({ target: { checked: false } });
  await tick();
  expect(mark).toHaveBeenLastCalledWith(OAK, "PR_mock9", "src/session.ts", false);
  expect(viewedBox(v, "src/session.ts")!.props.checked).toBe(false);
  expect(v.diff("src/session.ts").props.open).toBe(true);
});

it("a failed mark puts the box back and says why", async () => {
  const api = withPr([]);
  vi.spyOn(api, "worktreePrFileViewed").mockRejectedValue({ code: "gh_auth" });
  const v = review(api);
  await tick();
  viewedBox(v, "src/status.ts")!.props.onChange({ target: { checked: true } });
  await tick();
  expect(viewedBox(v, "src/status.ts")!.props.checked).toBe(false);
  expect(v.html()).toContain(en("error.gh_auth"));
});

it("no Viewed box without an open PR or when the viewed read fails", async () => {
  const none = review(createMockApi({}));
  await tick();
  expect(none.diffs().length).toBeGreaterThan(0);
  expect(none.diffs().every((d) => nodes(d.props.extra).every((n) => n.type !== Checkbox))).toBe(true);
  hooks.values = [];
  const offline = review(withPr());
  await tick();
  expect(offline.diffs().every((d) => nodes(d.props.extra).every((n) => n.type !== Checkbox))).toBe(true);
});
