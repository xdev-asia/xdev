import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileText } from "@/api";
import { FileTabs } from "../fileTabs";
import { DocSync } from "./docSync";
import { ASK_AFTER_FILES, LspAskCounter } from "./lspAskModel";
import { LspStatusStore } from "./lspStatus";

const WT = "/wt/a";
const file = (text: string): FileText => ({ rel: "x", text, kind: "text", size: text.length, hash: "h", eol: "lf" });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(open = vi.fn().mockResolvedValue({ language: "typescript", state: "ready" }), ask = new LspAskCounter(null)) {
  const api = { lspOpen: open, lspChange: vi.fn().mockResolvedValue(undefined), lspClose: vi.fn().mockResolvedValue(undefined) };
  const store = new FileTabs();
  const status = new LspStatusStore();
  const sync = new DocSync(api, store, status, 200, ask);
  return { api, store, status, sync };
}
const ready = (store: FileTabs, rel: string, text: string) => {
  store.open(WT, rel);
  store.loaded(WT, rel, file(text));
};

/** A counter that has seen enough other .ts files in the repo. */
function enough(): LspAskCounter {
  const ask = new LspAskCounter(null);
  for (let i = 1; i < ASK_AFTER_FILES; i++) ask.note(WT, `seen${i}.ts`);
  return ask;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("opens each ready text file with a language once", async () => {
  const { api, store, status } = setup();
  store.open(WT, "a.ts");
  await flush();
  expect(api.lspOpen).not.toHaveBeenCalled();
  store.loaded(WT, "a.ts", file("let a"));
  ready(store, "notes.md", "# hi");
  store.edit(WT, "a.ts", "let a;");
  await flush();
  expect(api.lspOpen).toHaveBeenCalledTimes(1);
  expect(api.lspOpen).toHaveBeenCalledWith(WT, "a.ts", "typescript", 1, "let a");
  expect(status.doc(WT, "a.ts")).toBe("ready");
});

it("sends one change per pause with growing versions", async () => {
  const { api, store } = setup();
  ready(store, "a.ts", "a");
  await flush();
  store.edit(WT, "a.ts", "ab");
  store.edit(WT, "a.ts", "abc");
  await vi.advanceTimersByTimeAsync(250);
  expect(api.lspChange).toHaveBeenCalledTimes(1);
  expect(api.lspChange).toHaveBeenLastCalledWith(WT, "a.ts", 2, "abc");
  store.edit(WT, "a.ts", "abcd");
  await vi.advanceTimersByTimeAsync(250);
  expect(api.lspChange).toHaveBeenLastCalledWith(WT, "a.ts", 3, "abcd");
});

it("closes a document when its tab goes", async () => {
  const { api, store } = setup();
  ready(store, "a.ts", "a");
  await flush();
  store.close(WT, "a.ts");
  await flush();
  expect(api.lspClose).toHaveBeenCalledWith(WT, "a.ts");
});

it("asks for trust when the host refuses, and opens again on retry", async () => {
  const open = vi.fn().mockRejectedValueOnce({ code: "lsp_untrusted" }).mockResolvedValue({ language: "typescript", state: "ready" });
  const { api, store, status, sync } = setup(open, enough());
  ready(store, "a.ts", "a");
  await flush();
  expect(status.doc(WT, "a.ts")).toBe("untrusted");
  expect(status.asking(WT)).toBe(true);
  store.edit(WT, "a.ts", "ab");
  await vi.advanceTimersByTimeAsync(250);
  expect(api.lspChange).not.toHaveBeenCalled();
  sync.retry(WT);
  await flush();
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenLastCalledWith(WT, "a.ts", "typescript", 1, "ab");
  expect(status.doc(WT, "a.ts")).toBe("ready");
});

it("does not ask again after a no this session", async () => {
  const open = vi.fn().mockRejectedValue({ code: "lsp_untrusted", detail: "session" });
  const { store, status } = setup(open, enough());
  ready(store, "a.ts", "a");
  await flush();
  expect(status.doc(WT, "a.ts")).toBe("untrusted");
  expect(status.asking(WT)).toBe(false);
});

it("does not ask at the first small file, only at the third file of a language", async () => {
  const open = vi.fn().mockRejectedValue({ code: "lsp_untrusted" });
  const { store, status } = setup(open);
  ready(store, "a.ts", "a");
  ready(store, "b.ts", "b");
  await flush();
  expect(status.doc(WT, "a.ts")).toBe("untrusted");
  expect(status.asking(WT)).toBe(false);
  ready(store, "c.ts", "c");
  await flush();
  expect(status.asking(WT)).toBe(true);
});

it("counts each language apart", async () => {
  const open = vi.fn().mockRejectedValue({ code: "lsp_untrusted" });
  const { store, status } = setup(open);
  ready(store, "a.ts", "a");
  ready(store, "b.rs", "b");
  ready(store, "c.py", "c");
  await flush();
  expect(status.asking(WT)).toBe(false);
});
