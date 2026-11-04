import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type FileHits, type SearchEvent } from "@/api";
import { translate } from "@/i18n";
import { SearchPanel, SEARCH_DEBOUNCE_MS } from "./SearchPanel";

type Cleanup = void | (() => void);
const hooks = vi.hoisted(() => ({
  active: false,
  values: [] as unknown[],
  cursor: 0,
  effects: [] as { deps: unknown[] | undefined; cleanup: unknown }[],
  effectCursor: 0,
  pending: [] as { index: number; run: () => unknown }[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: any) => {
      if (!hooks.active) return react.useState(initial);
      const index = slot(initial);
      const values = hooks.values;
      return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? (value as any)(values[index]) : value; }];
    },
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const index = slot(() => ({ current: initial }));
      return hooks.values[index];
    },
    useEffect: (effect: any, deps?: unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      const index = hooks.effectCursor++;
      const prev = hooks.effects[index];
      const same = prev && deps && prev.deps && deps.every((d, i) => Object.is(d, prev.deps![i]));
      if (same) return;
      hooks.pending.push({ index, run: () => {
        if (typeof prev?.cleanup === "function") (prev.cleanup as () => void)();
        hooks.effects[index] = { deps, cleanup: effect() };
      } });
    },
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
const WT = "/demo/wt/xdev-oak";
const hit = (line: number, text: string, ranges: [number, number][]) => ({ line, text, ranges });
const file = (rel: string, hits: FileHits["hits"]): FileHits => ({ rel, hits, more: false });

function panel(over: { focusSeq?: number; worktree?: string | null } = {}) {
  const searches: { id: string; onEvent: (e: SearchEvent) => void; text: string }[] = [];
  const base = createMockApi({});
  const api = {
    ...base,
    filesSearch: vi.fn((_wt: string, q: { text: string }, id: string, onEvent: (e: SearchEvent) => void) => {
      searches.push({ id, onEvent, text: q.text });
      return new Promise<void>(() => undefined);
    }),
    filesSearchCancel: vi.fn(async () => undefined),
  } as unknown as Api;
  const onOpen = vi.fn();
  const values: unknown[] = [];
  hooks.values = values;
  hooks.effects = [];
  let focusSeq = over.focusSeq ?? 0;
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.effectCursor = 0;
    hooks.active = true;
    try { return SearchPanel({ api, worktree: over.worktree === undefined ? WT : over.worktree, focusSeq, onOpen }) as Node; } finally { hooks.active = false; }
  };
  // Draws and runs the effects that changed, until they settle.
  const flush = () => {
    let tree = draw();
    for (let i = 0; i < 5 && hooks.pending.length > 0; i++) {
      hooks.pending.splice(0).forEach((p) => p.run());
      tree = draw();
    }
    return tree;
  };
  flush();
  const tree = () => flush();
  const input = () => nodes(tree()).find((n) => n.props.className === "sr-input")!;
  const type = (text: string) => { input().props.onChange({ target: { value: text } }); flush(); };
  return {
    api, onOpen, searches, type, tree, input,
    html: () => renderToStaticMarkup(tree()),
    all: () => nodes(tree()),
    refocus: (seq: number) => { focusSeq = seq; flush(); },
  };
}

beforeEach(() => { vi.useFakeTimers(); hooks.pending = []; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("typing sends one search after the debounce", () => {
  const p = panel();
  p.type("f");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
  p.type("fo");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
  expect(p.searches).toHaveLength(0);
  vi.advanceTimersByTime(60);
  expect(p.searches.map((s) => s.text)).toEqual(["fo"]);
  expect(p.html()).toContain(translate("en", "search.files.searching"));
});

it("a second change cancels the first search and drops its late events", () => {
  const p = panel();
  p.type("foo");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  const [first] = p.searches;
  p.type("foob");
  expect(p.api.filesSearchCancel).toHaveBeenCalledWith(first.id);
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  expect(p.searches).toHaveLength(2);
  first.onEvent({ type: "batch", files: [file("old.ts", [hit(1, "old", [[0, 3]])])] });
  expect(p.html()).not.toContain("old.ts");
});

it("batches append and the summary counts them", () => {
  const p = panel();
  p.type("foo");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  const { onEvent } = p.searches[0];
  onEvent({ type: "batch", files: [file("a.ts", [hit(3, "a foo", [[2, 5]])])] });
  onEvent({ type: "batch", files: [file("b/b.ts", [hit(1, "foo", [[0, 3]]), hit(2, "foo foo", [[0, 3], [4, 7]])])] });
  onEvent({ type: "done", files: 2, hits: 3, truncated: false, ms: 5 });
  const html = p.html();
  expect(html).toContain("a.ts");
  expect(html).toContain("b.ts");
  expect(html).toContain(translate("en", "search.files.summary", { hits: 3, files: 2 }));
});

it("highlights by code points: an emoji before the match does not shift it", () => {
  const p = panel();
  p.type("foo");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  p.searches[0].onEvent({ type: "batch", files: [file("a.ts", [hit(1, "😀 foo", [[2, 5]])])] });
  expect(p.html()).toContain('<mark class="sr-hit">foo</mark>');
});

it("clicking a hit opens the file at its line and column", () => {
  const p = panel();
  p.type("foo");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  p.searches[0].onEvent({ type: "batch", files: [file("src/a.ts", [hit(7, "  foo", [[2, 5]])])] });
  const line = p.all().find((n) => n.props.className === "sr-line")!;
  line.props.onClick();
  expect(p.onOpen).toHaveBeenCalledWith("src/a.ts", { line: 7, column: 3 });
});

it("a bad regex shows the message", () => {
  const p = panel();
  p.type("(");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  p.searches[0].onEvent({ type: "error", message: "unclosed group" });
  expect(p.html()).toContain("unclosed group");
});

it("a new focus request focuses the query box", () => {
  const p = panel();
  const focus = vi.fn();
  p.input().props.ref.current = { focus, select: vi.fn() };
  p.refocus(1);
  expect(focus).toHaveBeenCalled();
});

it("without a worktree it never searches", () => {
  const p = panel({ worktree: null });
  p.type("foo");
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
  expect(p.searches).toHaveLength(0);
});
