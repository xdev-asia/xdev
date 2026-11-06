import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileText } from "@/api";
import { FileTabs } from "../fileTabs";
import { DocSync } from "./docSync";
import { LspStatusStore } from "./lspStatus";

const WT = "/wt/a";
const file = (text: string): FileText => ({ rel: "x", text, kind: "text", size: text.length, hash: "h", eol: "lf" });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(open = vi.fn().mockResolvedValue({ language: "typescript", state: "ready" })) {
  const api = { lspOpen: open, lspChange: vi.fn().mockResolvedValue(undefined), lspClose: vi.fn().mockResolvedValue(undefined) };
  const store = new FileTabs();
  const status = new LspStatusStore();
  const sync = new DocSync(api, store, status, 200);
  return { api, store, status, sync };
}
const ready = (store: FileTabs, rel: string, text: string) => {
  store.open(WT, rel);
  store.loaded(WT, rel, file(text));
};

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
  const { api, store, status, sync } = setup(open);
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
  const { store, status } = setup(open);
  ready(store, "a.ts", "a");
  await flush();
  expect(status.doc(WT, "a.ts")).toBe("untrusted");
  expect(status.asking(WT)).toBe(false);
});
