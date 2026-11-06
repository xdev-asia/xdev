// There is no DOM in vitest here, so the parts that draw (hover, underlines, the trust panel) are covered by
// e2e/code-intel.spec.ts. These tests run the completion source and the key bindings on a real EditorState.
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { beforeEach, expect, it, vi } from "vitest";
import type { LspCompletionItem } from "@/api";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { DiagnosticsStore } from "./diagnosticsStore";
import { lspCompletionSource, lspPlugin, type LspDeps } from "./lspExtension";
import { LspStatusStore } from "./lspStatus";

const WT = "/wt/a";
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
const pos = (line: number, character: number) => ({ line, character });
const item = (label: string, over: Partial<LspCompletionItem> = {}): LspCompletionItem => ({ label, kind: 3, detail: null, insertText: label, range: null, sortText: null, filterText: null, ...over });

function deps(api: Partial<LspDeps["api"]> = {}) {
  return {
    api: { lspHover: vi.fn(), lspDefinition: vi.fn(), lspCompletion: vi.fn(), lspPrepareRename: vi.fn(), lspTrust: vi.fn(), ...api } as LspDeps["api"],
    t,
    retry: vi.fn(),
    open: vi.fn<LspDeps["open"]>(),
    ask: vi.fn<LspDeps["ask"]>(),
    diagnostics: new DiagnosticsStore(),
    status: new LspStatusStore(),
    mac: false,
  } satisfies LspDeps;
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => resetToastsForTests());

it("maps the server's items and starts at the word", async () => {
  const d = deps({ lspCompletion: vi.fn().mockResolvedValue({ incomplete: false, items: [item("greet", { detail: "(): void", insertText: "greet()" }), item("great")] }) });
  const state = EditorState.create({ doc: "gre" });
  const result = await lspCompletionSource(d, WT, "a.ts")(new CompletionContext(state, 3, false));
  expect(d.api.lspCompletion).toHaveBeenCalledWith(WT, "a.ts", pos(0, 3));
  expect(result?.from).toBe(0);
  expect(result?.options.map((o) => [o.label, o.type, o.detail, o.apply])).toEqual([
    ["greet", "function", "(): void", "greet()"],
    ["great", "function", undefined, "great"],
  ]);
  expect(result?.validFor).toBeDefined();
});

it("starts at the range of the first item when the server gives one", async () => {
  const range = { start: pos(0, 4), end: pos(0, 6) };
  const d = deps({ lspCompletion: vi.fn().mockResolvedValue({ incomplete: true, items: [item("name", { range })] }) });
  const state = EditorState.create({ doc: "obj.na" });
  const result = await lspCompletionSource(d, WT, "a.ts")(new CompletionContext(state, 6, false));
  expect(result?.from).toBe(4);
  expect(result?.validFor).toBeUndefined();
});

it("asks nothing without a word, unless the person asked", async () => {
  const d = deps({ lspCompletion: vi.fn().mockResolvedValue({ incomplete: false, items: [] }) });
  const state = EditorState.create({ doc: "a " });
  const source = lspCompletionSource(d, WT, "a.ts");
  expect(await source(new CompletionContext(state, 2, false))).toBeNull();
  expect(d.api.lspCompletion).not.toHaveBeenCalled();
  await source(new CompletionContext(state, 2, true));
  expect(d.api.lspCompletion).toHaveBeenCalledTimes(1);
});

it("gives no extensions for a file no server handles", () => {
  expect(lspPlugin(deps())({ worktree: WT, rel: "README.md", secondary: false })).toEqual([]);
});

function binding(d: LspDeps, key: string, doc: string, head: number) {
  const state = EditorState.create({ doc, selection: { anchor: head }, extensions: lspPlugin(d)({ worktree: WT, rel: "src/a.ts", secondary: false }) });
  const found = state.facet(keymap).flat().find((b) => b.key === key);
  return () => found!.run!({ state, coordsAtPos: () => ({ left: 5, bottom: 9 }) } as unknown as EditorView);
}

it("opens the one definition at its 1-based line and column", async () => {
  const d = deps({ lspDefinition: vi.fn().mockResolvedValue([{ rel: "src/b.ts", path: "/wt/a/src/b.ts", range: { start: pos(4, 7), end: pos(4, 9) } }]) });
  binding(d, "F12", "let a = b", 9)();
  await flush();
  expect(d.api.lspDefinition).toHaveBeenCalledWith(WT, "src/a.ts", pos(0, 9));
  expect(d.open).toHaveBeenCalledWith({ worktree: WT, rel: "src/b.ts", line: 5, column: 8 });
});

it("asks for a pick when there are several definitions", async () => {
  const at = (line: number) => ({ rel: "src/b.ts", path: "/p", range: { start: pos(line, 0), end: pos(line, 1) } });
  const d = deps({ lspDefinition: vi.fn().mockResolvedValue([at(1), at(2)]) });
  binding(d, "F12", "x", 1)();
  await flush();
  expect(d.open).not.toHaveBeenCalled();
  expect(d.ask).toHaveBeenCalledWith({ kind: "definitions", worktree: WT, at: { x: 5, y: 9 }, targets: [{ rel: "src/b.ts", line: 2, column: 1 }, { rel: "src/b.ts", line: 3, column: 1 }] });
});

it("says so when there is no definition or it lies outside the worktree", async () => {
  const d = deps({ lspDefinition: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ rel: null, path: "/lib/x.ts", range: { start: pos(0, 0), end: pos(0, 1) } }]) });
  binding(d, "F12", "x", 0)();
  await flush();
  expect(getToasts().at(-1)?.text).toBe("lsp.definition.none");
  binding(d, "F12", "x", 0)();
  await flush();
  expect(getToasts().at(-1)?.text).toBe("lsp.definition.outside");
});

it("asks for a new name with the word under the caret", async () => {
  const d = deps({ lspPrepareRename: vi.fn().mockResolvedValue({ start: pos(0, 4), end: pos(0, 7) }) });
  binding(d, "F2", "let foo = 1", 5)();
  await flush();
  expect(d.ask).toHaveBeenCalledWith({ kind: "rename", worktree: WT, rel: "src/a.ts", pos: pos(0, 4), name: "foo" });
});

it("says a symbol cannot be renamed", async () => {
  const d = deps({ lspPrepareRename: vi.fn().mockResolvedValue(null) });
  binding(d, "F2", "let foo = 1", 0)();
  await flush();
  expect(d.ask).not.toHaveBeenCalled();
  expect(getToasts().at(-1)?.text).toBe("lsp.rename.cannot");
});
