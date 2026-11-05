import { expect, it } from "vitest";
import { editorFontStack } from "./editorFont";

const MONO = "var(--x-font-mono)";

it("uses the editor font and ends with the mono token", () => {
  expect(editorFontStack("Fira Code", "Menlo")).toBe(`Fira Code, ${MONO}`);
});

it("empty editor font follows the terminal font", () => {
  expect(editorFontStack("", "Menlo")).toBe(`Menlo, ${MONO}`);
  expect(editorFontStack("   ", "Menlo")).toBe(`Menlo, ${MONO}`);
});

it("both empty fall back to the mono token", () => {
  expect(editorFontStack("", "")).toBe(MONO);
  expect(editorFontStack(" ", "\u0007")).toBe(MONO);
});

it("drops control characters", () => {
  expect(editorFontStack("  Fira\u0007 Code\n ", "")).toBe(`Fira Code, ${MONO}`);
});

it("does not repeat the mono token", () => {
  expect(editorFontStack("Fira Code, var(--x-font-mono)", "")).toBe("Fira Code, var(--x-font-mono)");
  expect(editorFontStack(MONO, "")).toBe(MONO);
});
