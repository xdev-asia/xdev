import { expect, it } from "vitest";
import { languageOf, loadLanguage, type Language } from "./languages";

it("picks a language by extension, plain text for the rest", () => {
  expect(languageOf("src/App.tsx")).toBe("ts");
  expect(languageOf("a/b/main.RS")).toBe("rust");
  expect(languageOf("package.json")).toBe("json");
  expect(languageOf("notes.md")).toBe("markdown");
  expect(languageOf("ci.yml")).toBe("yaml");
  expect(languageOf("Makefile")).toBeNull();
  expect(languageOf(".gitignore")).toBeNull();
  expect(languageOf("dir.d/file")).toBeNull();
  expect(languageOf("notes.txt")).toBeNull();
});

it("loads every language it names", async () => {
  const all: Language[] = ["js", "ts", "rust", "json", "css", "html", "python", "yaml", "markdown"];
  for (const lang of all) expect(await loadLanguage(lang)).toBeTruthy();
});
