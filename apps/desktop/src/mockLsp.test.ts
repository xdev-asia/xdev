import { expect, it } from "vitest";
import type { LspEvent } from "./api";
import { createMockApi } from "./mockApi";
import { createMockLsp, wordAt } from "./mockLsp";

const W = "/demo/wt";
const MATH = "export function addUp(a: number, b: number) {\n  return a + b;\n}\nexport const LIMIT = 3;\n";
const MAIN = 'import { addUp } from "./math";\n// TODO check the limit\nconst total = addUp(1, 2);\n';

async function opened() {
  const lsp = createMockLsp();
  const events: LspEvent[] = [];
  await lsp.lspSubscribe((e) => events.push(e));
  await lsp.lspTrust(W, true);
  await lsp.lspOpen(W, "src/math.ts", "typescript", 1, MATH);
  await lsp.lspOpen(W, "src/main.ts", "typescript", 1, MAIN);
  return { lsp, events };
}

it("refuses an untrusted worktree, then opens it once trusted", async () => {
  const lsp = createMockLsp();
  await expect(lsp.lspOpen(W, "a.ts", "typescript", 1, "")).rejects.toEqual({ code: "lsp_untrusted" });
  await lsp.lspTrust(W, false);
  await expect(lsp.lspOpen(W, "a.ts", "typescript", 1, "")).rejects.toMatchObject({ code: "lsp_untrusted", detail: "session" });
  await lsp.lspTrust(W, true);
  await lsp.lspTrust(W, true);
  expect((await lsp.lspSettingsGet()).trusted).toEqual([W]);
  expect(await lsp.lspOpen(W, "a.ts", "typescript", 1, "")).toEqual({ language: "typescript", state: "ready" });
  await expect(lsp.lspOpen(W, "a.py", "python", 1, "")).rejects.toMatchObject({ code: "lsp_not_found" });
  expect(await lsp.lspOpen(W, "a.md", "markdown", 1, "")).toEqual({ language: null, state: "notFound" });
  expect(await lsp.lspStatus()).toEqual([{ worktree: W, language: "typescript", state: "ready", openDocs: 1 }]);
});

it("hovers a declared name", async () => {
  const { lsp } = await opened();
  const hover = await lsp.lspHover(W, "src/main.ts", { line: 2, character: 15 });
  expect(hover?.markdown).toContain("export function addUp(a: number, b: number) {");
  expect(hover?.range).toEqual({ start: { line: 2, character: 14 }, end: { line: 2, character: 19 } });
  expect(await lsp.lspHover(W, "src/main.ts", { line: 2, character: 2 })).toBeNull();
});

it("finds a definition in another open file", async () => {
  const { lsp } = await opened();
  expect(await lsp.lspDefinition(W, "src/main.ts", { line: 2, character: 16 })).toEqual([
    { rel: "src/math.ts", path: `${W}/src/math.ts`, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } },
  ]);
  const completion = await lsp.lspCompletion(W, "src/main.ts", { line: 2, character: 0 });
  expect(completion.items.map((i) => i.label)).toEqual(["addUp", "LIMIT"]);
});

it("sends a warning for a TODO line", async () => {
  const { events } = await opened();
  expect(events).toContainEqual({
    kind: "diagnostics",
    worktree: W,
    rel: "src/main.ts",
    items: [{ range: { start: { line: 1, character: 3 }, end: { line: 1, character: 7 } }, severity: 2, message: "Unfinished work: TODO", source: "demo", code: null }],
  });
  expect(events.filter((e) => e.kind === "status")).toEqual([{ kind: "status", worktree: W, language: "typescript", state: "ready" }]);
});

it("renames every whole word in the open files", async () => {
  const { lsp } = await opened();
  expect(await lsp.lspPrepareRename(W, "src/math.ts", { line: 0, character: 18 })).toEqual({ start: { line: 0, character: 16 }, end: { line: 0, character: 21 } });
  const edit = await lsp.lspRename(W, "src/math.ts", { line: 0, character: 18 }, "sum");
  expect(edit.skipped).toBe(0);
  expect(edit.files.map((f) => [f.rel, f.edits.length])).toEqual([
    ["src/math.ts", 1],
    ["src/main.ts", 2],
  ]);
  expect(edit.files[1].edits[1]).toEqual({ range: { start: { line: 2, character: 14 }, end: { line: 2, character: 19 } }, newText: "sum" });
});

it("filters symbols by the query", async () => {
  const { lsp } = await opened();
  expect((await lsp.lspWorkspaceSymbols(W, "lim")).map((s) => [s.name, s.kind, s.rel])).toEqual([["LIMIT", 14, "src/math.ts"]]);
  expect(await lsp.lspWorkspaceSymbols(W, "")).toHaveLength(2);
  await expect(createMockLsp().lspWorkspaceSymbols(W, "")).rejects.toMatchObject({ code: "lsp_not_found" });
});

it("turning a language off stops its servers", async () => {
  const { lsp, events } = await opened();
  const settings = await lsp.lspSettingsPut({ enabled: true, disabled: ["typescript"], idleMinutes: 500, trusted: [W] });
  expect(settings.idleMinutes).toBe(120);
  expect(events.at(-1)).toEqual({ kind: "status", worktree: W, language: "typescript", state: "stopped" });
  expect(await lsp.lspStatus()).toEqual([]);
  await expect(lsp.lspOpen(W, "a.ts", "typescript", 1, "")).rejects.toMatchObject({ code: "lsp_off" });
});

it("finds the word under the caret at either edge", () => {
  expect(wordAt("a fooBar b", { line: 0, character: 2 })?.word).toBe("fooBar");
  expect(wordAt("a fooBar b", { line: 0, character: 8 })?.word).toBe("fooBar");
  expect(wordAt("a  b", { line: 0, character: 2 })).toBeNull();
  expect(wordAt("a", { line: 3, character: 0 })).toBeNull();
});

it("is part of the mock api", async () => {
  const api = createMockApi({});
  const rows = await api.lspServers(false);
  expect(rows.find((r) => r.language === "typescript")?.path).toBe("/usr/local/bin/typescript-language-server");
  expect(rows.find((r) => r.language === "python")).toMatchObject({ path: null, program: "pyright-langserver" });
});
