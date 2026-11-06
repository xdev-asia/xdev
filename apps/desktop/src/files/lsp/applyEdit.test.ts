import { beforeEach, expect, it, vi } from "vitest";
import type { FileText, LspTextEdit } from "@/api";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { FileTabs } from "../fileTabs";
import { applyTextEdits, applyWorkspaceEdit, MAX_RENAME_FILES } from "./applyEdit";

const WT = "/wt/a";
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
const edit = (l: number, c: number, l2: number, c2: number, newText: string): LspTextEdit => ({ range: { start: { line: l, character: c }, end: { line: l2, character: c2 } }, newText });
const file = (text: string): FileText => ({ rel: "x", text, kind: "text", size: text.length, hash: "h", eol: "lf" });

beforeEach(() => resetToastsForTests());

it("applies several edits against the original text", () => {
  expect(applyTextEdits("foo foo\nfoo", [edit(1, 0, 1, 3, "barbaz"), edit(0, 0, 0, 3, "b"), edit(0, 4, 0, 7, "bb")])).toBe("b bb\nbarbaz");
});

it("keeps the order of inserts at one place", () => {
  expect(applyTextEdits("x", [edit(0, 0, 0, 0, "a"), edit(0, 0, 0, 0, "b")])).toBe("abx");
});

function openReady(store: FileTabs, rel: string, text: string) {
  store.open(WT, rel);
  store.loaded(WT, rel, file(text));
}

it("edits an open file in its buffer", async () => {
  const store = new FileTabs();
  openReady(store, "a.ts", "foo");
  const fileRead = vi.fn();
  await applyWorkspaceEdit({ files: [{ rel: "a.ts", edits: [edit(0, 0, 0, 3, "bar")] }], skipped: 0 }, { worktree: WT, store, api: { fileRead }, t });
  expect(fileRead).not.toHaveBeenCalled();
  expect(store.get(WT, "a.ts")?.text).toBe("bar");
  expect(getToasts()[0].text).toBe('lsp.rename.done{"files":1}');
});

it("reads and opens a file that is not open", async () => {
  const store = new FileTabs();
  const fileRead = vi.fn().mockResolvedValue(file("foo()"));
  await applyWorkspaceEdit({ files: [{ rel: "b.ts", edits: [edit(0, 0, 0, 3, "bar")] }], skipped: 0 }, { worktree: WT, store, api: { fileRead }, t });
  expect(fileRead).toHaveBeenCalledWith(WT, "b.ts");
  const entry = store.get(WT, "b.ts");
  expect(entry?.status).toBe("ready");
  expect(entry?.text).toBe("bar()");
});

it("refuses a rename over too many files and changes nothing", async () => {
  const store = new FileTabs();
  const files = Array.from({ length: MAX_RENAME_FILES + 1 }, (_, i) => ({ rel: `f${i}.ts`, edits: [edit(0, 0, 0, 1, "x")] }));
  const fileRead = vi.fn();
  await applyWorkspaceEdit({ files, skipped: 0 }, { worktree: WT, store, api: { fileRead }, t });
  expect(fileRead).not.toHaveBeenCalled();
  expect(store.all()).toHaveLength(0);
  expect(getToasts()[0].text).toBe('lsp.rename.tooMany{"n":51}');
});

it("says how many changes were left out", async () => {
  const store = new FileTabs();
  openReady(store, "a.ts", "foo");
  await applyWorkspaceEdit({ files: [{ rel: "a.ts", edits: [edit(0, 0, 0, 3, "bar")] }], skipped: 2 }, { worktree: WT, store, api: { fileRead: vi.fn() }, t });
  expect(getToasts()[0].text).toBe('lsp.rename.done{"files":1} lsp.rename.skipped{"skipped":2}');
});
