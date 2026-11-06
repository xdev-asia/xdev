import { expect, it } from "vitest";
import { ASK_AFTER_FILES, LspAskCounter, type AskStore } from "./lspAskModel";

const memory = (): AskStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

it("asks at the third distinct file of a language in one repo", () => {
  const c = new LspAskCounter(memory());
  expect(ASK_AFTER_FILES).toBe(3);
  expect(c.shouldAsk("/r", "a.ts")).toBe(false);
  expect(c.shouldAsk("/r", "a.ts")).toBe(false);
  expect(c.shouldAsk("/r", "src/b.tsx")).toBe(false);
  expect(c.shouldAsk("/r", "c.mts")).toBe(false);
  expect(c.shouldAsk("/r", "d.ts")).toBe(true);
});

it("keeps repos and languages apart and ignores files no server handles", () => {
  const c = new LspAskCounter(memory());
  c.note("/r", "a.ts");
  c.note("/r", "b.ts");
  expect(c.note("/other", "c.ts")).toBe(1);
  expect(c.note("/r", "x.rs")).toBe(1);
  expect(c.note("/r", "notes.md")).toBe(0);
  expect(c.shouldAsk("/r", "notes.md")).toBe(false);
});

it("survives a restart and a broken store", () => {
  const store = memory();
  new LspAskCounter(store).note("/r", "a.rs");
  new LspAskCounter(store).note("/r", "b.rs");
  expect(new LspAskCounter(store).shouldAsk("/r", "c.rs")).toBe(true);
  store.data.set("xdev.lsp.seen", "{not json");
  expect(new LspAskCounter(store).note("/r", "a.rs")).toBe(1);
});
