import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { BasePicker } from "./BasePicker";
import { FileDiff } from "./FileDiff";
import { ReviewView } from "./ReviewView";
import { VIEW_KEY } from "./viewOptions";

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
  vi.spyOn(api, "worktreeReview").mockResolvedValue({ base: { kind: "start", name: null, id: START }, branch: "oak", baseRef: "main", files });
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
  v.diff("src/session.ts").props.onStage(v.diff("src/session.ts").props.file);
  await tick();
  expect(stage).toHaveBeenLastCalledWith(OAK, ["src/session.ts"], true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(v.diff("src/session.ts").props.file).toMatchObject({ staged: true, unstaged: false });
  v.diff("src/session.ts").props.onStage(v.diff("src/session.ts").props.file);
  await tick();
  expect(stage).toHaveBeenLastCalledWith(OAK, ["src/session.ts"], false);
});

it("saves the view options and restores them", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, x: string) => void saved.set(k, x) });
  const api = createMockApi({});
  const v = review(api);
  await tick();
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ layout: "inline", ignoreWhitespace: false });
  const whitespace = v.all().find((n) => n.type === "input" && n.props.type === "checkbox" && !n.props.checked)!;
  whitespace.props.onChange();
  v.all().find((n) => n.type === "button" && n.props["aria-pressed"] === false)!.props.onClick();
  expect(JSON.parse(saved.get(VIEW_KEY)!)).toMatchObject({ layout: "split", ignoreWhitespace: true });
  expect(v.diff("src/session.ts").props.opts).toMatchObject({ layout: "split", ignoreWhitespace: true });

  const again = review(api);
  await tick();
  expect(again.diff("src/session.ts").props.opts).toMatchObject({ layout: "split", ignoreWhitespace: true });
});

it("the file list resizes by keyboard within its limits", async () => {
  const api = createMockApi({});
  const v = review(api);
  await tick();
  const bar = () => v.all().find((n) => n.props.role === "separator")!;
  expect(bar().props["aria-valuenow"]).toBe(240);
  bar().props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
  expect(bar().props["aria-valuenow"]).toBe(256);
  for (let i = 0; i < 40; i++) bar().props.onKeyDown({ key: "ArrowLeft", preventDefault() {} });
  expect(bar().props["aria-valuenow"]).toBe(160);
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
