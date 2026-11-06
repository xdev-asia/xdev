// The dialog itself (typing, Enter, the list) runs in e2e/code-intel.spec.ts: vitest has no DOM here.
import { expect, it } from "vitest";
import { moveActive, symbolMessage, type Found } from "./SymbolDialog";

const t = (key: string) => key;
const found = (over: Partial<Found> = {}): Found => ({ query: "foo", items: [], error: null, ...over });
const sym = { name: "foo", kind: 12, container: null, rel: "a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };

it("says nothing before the answer for the typed text is in", () => {
  expect(symbolMessage(null, "foo", t)).toBe("");
  expect(symbolMessage(found({ query: "fo" }), "foo", t)).toBe("");
});

it("says no symbols match for an empty answer", () => {
  expect(symbolMessage(found(), " foo ", t)).toBe("lsp.symbols.empty");
});

it("says nothing when there are rows", () => {
  expect(symbolMessage(found({ items: [sym] }), "foo", t)).toBe("");
});

it("explains a missing server and other errors", () => {
  expect(symbolMessage(found({ error: "lsp_not_found" }), "foo", t)).toBe("lsp.symbols.noServer");
  expect(symbolMessage(found({ error: "lsp_timeout" }), "foo", t)).toBe("error.lsp_timeout");
});

it("moves the active row and wraps", () => {
  expect(moveActive(0, "ArrowDown", 3)).toBe(1);
  expect(moveActive(2, "ArrowDown", 3)).toBe(0);
  expect(moveActive(0, "ArrowUp", 3)).toBe(2);
  expect(moveActive(0, "ArrowDown", 0)).toBe(0);
});
