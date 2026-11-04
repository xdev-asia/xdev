import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { getFindOptions, resetFindOptionsForTests } from "./terminalFindOptions";
import { searchDecorations, TerminalFind, type SearchLike } from "./TerminalFind";

// Hooks are kept by call order; the component is called as a function and its element tree walked.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  effects: [] as { run: () => void | (() => void); deps?: unknown[] }[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const at = hooks.cursor++;
    if (!(at in hooks.states)) hooks.states[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [
      hooks.states[at],
      (v: unknown) => {
        hooks.states[at] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.states[at]) : v;
      },
    ];
  },
  useRef: (initial: unknown) => (hooks.refs[hooks.refCursor++] ??= { current: initial }),
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => void hooks.effects.push({ run, deps }),
}));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

type Result = { resultIndex: number; resultCount: number };

function fakeSearch(found = true) {
  let listener: (e: Result) => void = () => {};
  const dispose = vi.fn();
  const search = {
    findNext: vi.fn(() => found),
    findPrevious: vi.fn(() => found),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((l: (e: Result) => void) => {
      listener = l;
      return { dispose };
    }),
  };
  return { search: search as unknown as SearchLike & typeof search, emit: (e: Result) => listener(e), dispose };
}

function mount(search: SearchLike, over: { initial?: string; onClose?: () => void; focusSeq?: number } = {}) {
  hooks.states = [];
  hooks.refs = [];
  hooks.effects = [];
  const onClose = over.onClose ?? vi.fn();
  const props = { search, initial: over.initial ?? "", onClose, focusSeq: over.focusSeq };
  const draw = () => {
    hooks.cursor = 0;
    hooks.refCursor = 0;
    hooks.effects = [];
    return TerminalFind(props);
  };
  let tree = draw();
  const input = { focus: vi.fn(), select: vi.fn() };
  hooks.refs[0].current = input;
  const cleanups = hooks.effects.splice(0).map((e) => e.run());
  const unmount = () => cleanups.forEach((c) => typeof c === "function" && c());
  const all = () => nodes((tree = draw()));
  const by = (name: string) => all().find((n) => n.props["data-find"] === name)!;
  const key = (init: Partial<KeyboardEvent> & { key: string }) => {
    const e = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, code: "", preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init };
    by("input").props.onKeyDown(e);
    return e;
  };
  const type = (value: string) => by("input").props.onChange({ target: { value } });
  return { by, all, key, type, unmount, onClose, input, root: () => nodes(tree)[0] };
}

beforeEach(() => {
  resetFindOptionsForTests();
});

it("typing calls findNext incrementally with the options and decorations", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  f.type("err");
  expect(search.findNext).toHaveBeenCalledWith("err", {
    incremental: true,
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    decorations: expect.any(Object),
  });
  expect(f.by("input").props.value).toBe("err");
});

it("each toggle flips its option, keeps it for the session and searches again", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  f.type("err");
  search.findNext.mockClear();
  for (const [name, option] of [["case", "caseSensitive"], ["regex", "regex"], ["word", "wholeWord"]] as const) {
    expect(f.by(name).props["aria-pressed"]).toBe(false);
    f.by(name).props.onClick();
    expect(f.by(name).props["aria-pressed"]).toBe(true);
    expect(search.findNext).toHaveBeenLastCalledWith("err", expect.objectContaining({ incremental: true, [option]: true }));
    expect(getFindOptions()[option]).toBe(true);
  }
  expect(search.findNext).toHaveBeenCalledTimes(3);
  // Another pane's bar starts with the shared options.
  const other = mount(fakeSearch().search);
  expect(other.by("case").props["aria-pressed"]).toBe(true);
});

it("the toggles have labels and the Alt keys flip them", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  expect(f.by("case").props["aria-label"]).toContain(en("terminal.find.case"));
  expect(f.by("regex").props["aria-label"]).toContain(en("terminal.find.regex"));
  expect(f.by("word").props["aria-label"]).toContain(en("terminal.find.word"));
  const e = f.key({ key: "c", code: "KeyC", altKey: true });
  expect(e.preventDefault).toHaveBeenCalled();
  expect(f.by("case").props["aria-pressed"]).toBe(true);
  f.key({ key: "®", code: "KeyR", altKey: true });
  expect(f.by("regex").props["aria-pressed"]).toBe(true);
  f.key({ key: "w", code: "KeyW", altKey: true });
  expect(f.by("word").props["aria-pressed"]).toBe(true);
  f.key({ key: "c", code: "KeyC" });
  expect(f.by("case").props["aria-pressed"]).toBe(true);
});

it("AltGr (Ctrl+Alt) and Alt with Meta type a character instead of flipping a toggle", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  const altGr = f.key({ key: "©", code: "KeyC", altKey: true, ctrlKey: true });
  expect(altGr.preventDefault).not.toHaveBeenCalled();
  expect(f.by("case").props["aria-pressed"]).toBe(false);
  const meta = f.key({ key: "r", code: "KeyR", altKey: true, metaKey: true });
  expect(meta.preventDefault).not.toHaveBeenCalled();
  expect(f.by("regex").props["aria-pressed"]).toBe(false);
});

it("Enter finds the next match, Shift+Enter the previous; the buttons do the same", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  f.type("err");
  search.findNext.mockClear();
  f.key({ key: "Enter" });
  expect(search.findNext).toHaveBeenCalledWith("err", expect.not.objectContaining({ incremental: true }));
  f.key({ key: "Enter", shiftKey: true });
  expect(search.findPrevious).toHaveBeenCalledWith("err", expect.objectContaining({ decorations: expect.any(Object) }));
  f.by("next").props.onClick();
  f.by("prev").props.onClick();
  expect(search.findNext).toHaveBeenCalledTimes(2);
  expect(search.findPrevious).toHaveBeenCalledTimes(2);
});

it("the count reads 3 of 12, No results, and 1000+ over the limit", () => {
  const { search, emit } = fakeSearch();
  const f = mount(search);
  f.type("err");
  const text = () => f.by("count").props.children;
  emit({ resultIndex: 2, resultCount: 12 });
  expect(text()).toBe("3 of 12");
  emit({ resultIndex: 0, resultCount: 0 });
  expect(text()).toBe(en("terminal.find.none"));
  emit({ resultIndex: -1, resultCount: 1000 });
  expect(text()).toBe("1000+ matches");
});

it("a search that finds nothing reads No results even without an event", () => {
  const { search } = fakeSearch(false);
  const f = mount(search);
  f.type("zzz");
  expect(f.by("count").props.children).toBe(en("terminal.find.none"));
});

it("a bad regex is never searched; the input is marked invalid", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  f.by("regex").props.onClick();
  search.findNext.mockClear();
  f.type("(");
  expect(search.findNext).not.toHaveBeenCalled();
  f.key({ key: "Enter" });
  f.by("next").props.onClick();
  expect(search.findNext).not.toHaveBeenCalled();
  expect(search.findPrevious).not.toHaveBeenCalled();
  expect(f.by("input").props["aria-invalid"]).toBe(true);
  expect(f.by("count").props.children).toBe(en("terminal.find.invalid"));
  expect(search.clearDecorations).toHaveBeenCalled();
  // A valid pattern searches again.
  f.type("e+");
  expect(search.findNext).toHaveBeenCalledTimes(1);
  expect(f.by("input").props["aria-invalid"]).toBe(false);
  // Without the regex toggle "(" is plain text.
  f.by("regex").props.onClick();
  search.findNext.mockClear();
  f.type("(");
  expect(search.findNext).toHaveBeenCalledTimes(1);
});

it("an empty query searches nothing and clears the decorations", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  f.type("a");
  search.findNext.mockClear();
  f.type("");
  expect(search.findNext).not.toHaveBeenCalled();
  expect(search.clearDecorations).toHaveBeenCalled();
  expect(f.by("count").props.children).toBe("");
});

it("Escape clears the decorations and closes; so does the close button", () => {
  const { search } = fakeSearch();
  const f = mount(search);
  f.key({ key: "Escape" });
  expect(search.clearDecorations).toHaveBeenCalledTimes(1);
  expect(f.onClose).toHaveBeenCalledTimes(1);
  f.by("close").props.onClick();
  expect(f.onClose).toHaveBeenCalledTimes(2);
});

it("opens with the initial text searched, focused and selected; Ctrl+F selects the text", () => {
  const { search } = fakeSearch();
  const f = mount(search, { initial: "boom" });
  expect(f.by("input").props.value).toBe("boom");
  expect(search.findNext).toHaveBeenCalledWith("boom", expect.objectContaining({ incremental: true }));
  expect(f.input.focus).toHaveBeenCalled();
  expect(f.input.select).toHaveBeenCalled();
  f.input.select.mockClear();
  const e = f.key({ key: "f", code: "KeyF", ctrlKey: true });
  expect(e.preventDefault).toHaveBeenCalled();
  expect(f.input.select).toHaveBeenCalledTimes(1);
});

it("unmount unsubscribes and clears the decorations", () => {
  const { search, dispose } = fakeSearch();
  const f = mount(search);
  expect(search.onDidChangeResults).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
  f.unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(search.clearDecorations).toHaveBeenCalled();
});

it("decoration colours come from the tokens; a token that is not #rrggbb is left out", () => {
  const tokens: Record<string, string> = {
    "--bg-3": "#1e1e23",
    "--warn": "#f2b544",
    "--accent": "rgba(1, 2, 3, 0.5)",
    "--signal": "#5bd8ff",
  };
  const d = searchDecorations((n) => tokens[n]);
  expect(d).toEqual({
    matchBackground: "#1e1e23",
    matchBorder: "#f2b544",
    matchOverviewRuler: "#f2b544",
    activeMatchBorder: "#5bd8ff",
    activeMatchColorOverviewRuler: "#5bd8ff",
  });
  expect(Object.keys(searchDecorations(() => undefined))).toEqual([]);
});
