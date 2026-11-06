import { expect, it } from "vitest";
import { lspLanguageId } from "./languageIds";

it("names the language of a file by its extension", () => {
  expect(lspLanguageId("src/a.ts")).toBe("typescript");
  expect(lspLanguageId("a.tsx")).toBe("typescriptreact");
  expect(lspLanguageId("a.mjs")).toBe("javascript");
  expect(lspLanguageId("a.jsx")).toBe("javascriptreact");
  expect(lspLanguageId("crates/x/lib.rs")).toBe("rust");
  expect(lspLanguageId("a.pyi")).toBe("python");
  expect(lspLanguageId("main.go")).toBe("go");
  expect(lspLanguageId("A.CS")).toBe("csharp");
});

it("gives null for files no server reads", () => {
  expect(lspLanguageId("README.md")).toBeNull();
  expect(lspLanguageId("Makefile")).toBeNull();
  expect(lspLanguageId(".ts")).toBeNull();
  expect(lspLanguageId("dir.ts/file")).toBeNull();
});
