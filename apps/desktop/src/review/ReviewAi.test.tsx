import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Api } from "@/api";
import { createMockApi, type MockApi } from "@/mockApi";
import { translate } from "@/i18n";
import { MenuButton } from "@xdev-asia/ui";
import { FileDiff } from "./FileDiff";
import { ReviewView } from "./ReviewView";
import { AUTO_KEY } from "./aiReview";
import { isAiNote } from "./aiFindings";

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


function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size; },
  } as Storage;
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function review(api: Api) {
  const view = mount(() => ReviewView({ api, worktree: OAK }));
  const diffs = () => view.all().filter((n) => n.type === FileDiff);
  const diff = (path: string) => diffs().find((n) => n.props.file.path === path)!;
  // "Review with AI" sits in the toolbar's options menu.
  const runAi = () => view.all().find((n) => n.type === MenuButton)!.props.items.find((i: { label?: string }) => i.label === translate("en", "review.ai.run")).onSelect();
  const status = () => view.all().find((n) => n.props.role === "status" && String(n.props.className ?? "").includes("rv-ai-status"));
  return { ...view, diffs, diff, runAi };
}

async function settle() { for (let i = 0; i < 10; i++) await tick(); }
const withImage = (api: MockApi) => api.__addChange(OAK, { path: "assets/logo.png", kind: "modified" });
// The stubbed hooks run effects only on mount; this draws once more and runs the effects of that draw, as a render would.
function rerun(v: { draw(): unknown }) {
  const before = hooks.effects.length;
  v.draw();
  hooks.effects.slice(before).forEach((effect) => effect());
}

it("Review with AI asks about each hunk and shows the findings as AI notes on their files", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const api = createMockApi({});
  withImage(api);
  const plan = vi.spyOn(api, "worktreeReviewAiPlan");
  const hunk = vi.spyOn(api, "worktreeReviewAiHunk");
  const v = review(api);
  await tick();
  v.runAi();
  await settle();
  expect(plan).toHaveBeenCalledWith(OAK, START);
  // Two text hunks; the image is skipped as binary and the deleted file as deleted.
  expect(hunk).toHaveBeenCalledTimes(2);
  const notes = v.diff("src/session.ts").props.notes;
  expect(notes).toHaveLength(1);
  expect(isAiNote(notes[0])).toBe(true);
  expect(notes[0]).toMatchObject({ file: "src/session.ts", line: 2 });
  expect(v.diff("assets/logo.png").props.notes).toEqual([]);
  expect(en("review.ai.done", { count: 2 })).toBe("AI review done. Findings: 2.");
  expect(v.html()).toContain("AI review done. Findings: 2.");
  expect(v.html()).toContain('role="status"');
});

it("a finding can be dismissed, or turned into a note that the notes store saves", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const api = createMockApi({});
  const put = vi.spyOn(api, "reviewNotesPut");
  const v = review(api);
  await tick();
  v.runAi();
  await settle();
  const first = v.diff("src/session.ts").props.notes[0];
  v.diff("src/session.ts").props.handlers.dismissAi(first.id);
  expect(v.diff("src/session.ts").props.notes).toEqual([]);
  expect(put).not.toHaveBeenCalled();

  const second = v.diff("src/status.ts").props.notes[0];
  v.diff("src/status.ts").props.handlers.convertAi(second.id, { startLine: 2, line: 2, anchor: "export const value = 2;" });
  await settle();
  expect(put).toHaveBeenCalledTimes(1);
  const saved = put.mock.calls[0][1];
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ file: "src/status.ts", startLine: 2, line: 2, body: second.body, sentAt: null });
  expect(isAiNote(saved[0])).toBe(false);
  // The finding became the person's note: it shows once.
  const shown = v.diff("src/status.ts").props.notes;
  expect(shown).toHaveLength(1);
  expect(isAiNote(shown[0])).toBe(false);
});

it("Review automatically is off by default and runs once per diff when on", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const quiet = createMockApi({});
  const quietPlan = vi.spyOn(quiet, "worktreeReviewAiPlan");
  const a = review(quiet);
  await settle();
  rerun(a);
  await settle();
  expect(quietPlan).not.toHaveBeenCalled();
  a.cleanups.forEach((c) => typeof c === "function" && c());

  vi.stubGlobal("localStorage", memoryStorage({ [AUTO_KEY]: "1" }));
  const api = createMockApi({});
  const plan = vi.spyOn(api, "worktreeReviewAiPlan");
  const hunk = vi.spyOn(api, "worktreeReviewAiHunk");
  const b = review(api);
  await settle();
  // The diff is read: the first render with a diff starts the review.
  rerun(b);
  await settle();
  expect(plan).toHaveBeenCalledTimes(1);
  expect(hunk).toHaveBeenCalledTimes(2);
  // The same diff drawn again, or opened in another view: planned, never asked again.
  rerun(b);
  await settle();
  const again = review(api);
  await settle();
  rerun(again);
  await settle();
  expect(hunk).toHaveBeenCalledTimes(2);
  expect(plan.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(again.diff("src/session.ts").props.notes).toEqual([]);
});
