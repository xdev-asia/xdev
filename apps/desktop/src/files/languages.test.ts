import { expect, it } from "vitest";
import { languageOf, loadLanguage, type Language } from "./languages";

it("picks a language by extension, plain text for the rest", () => {
  expect(languageOf("src/App.tsx")).toBe("ts");
  expect(languageOf("a/b/main.RS")).toBe("rust");
  expect(languageOf("package.json")).toBe("json");
  expect(languageOf("notes.md")).toBe("markdown");
  expect(languageOf("ci.yml")).toBe("yaml");
  expect(languageOf("dir.d/file")).toBeNull();
  expect(languageOf("notes.txt")).toBeNull();
  expect(languageOf("LICENSE")).toBeNull();
});

it("maps the new extensions", () => {
  const want: Record<string, Language> = {
    "a.go": "go",
    "A.java": "java",
    "a.c": "cpp",
    "a.h": "cpp",
    "a.cpp": "cpp",
    "a.cc": "cpp",
    "a.cxx": "cpp",
    "a.hpp": "cpp",
    "a.hh": "cpp",
    "a.cs": "csharp",
    "a.php": "php",
    "a.sql": "sql",
    "a.xml": "xml",
    "a.svg": "xml",
    "a.xsd": "xml",
    "a.plist": "xml",
    "a.sh": "shell",
    "a.bash": "shell",
    "a.zsh": "shell",
    "a.fish": "shell",
    "a.toml": "toml",
    "a.ini": "ini",
    "a.cfg": "ini",
    "a.conf": "ini",
    "a.dockerfile": "dockerfile",
    "a.lua": "lua",
    "a.rb": "ruby",
    "a.swift": "swift",
    "a.kt": "kotlin",
    "a.kts": "kotlin",
    "a.diff": "diff",
    "a.patch": "diff",
    "a.properties": "properties",
  };
  for (const [file, lang] of Object.entries(want)) expect(languageOf(file), file).toBe(lang);
});

it("matches file names before extensions", () => {
  expect(languageOf("Dockerfile")).toBe("dockerfile");
  expect(languageOf("ci/Jenkinsfile")).toBe("groovy");
  expect(languageOf("Makefile")).toBe("shell");
  expect(languageOf("GNUmakefile")).toBe("shell");
  expect(languageOf("Justfile")).toBe("shell");
  expect(languageOf(".justfile")).toBe("shell");
  expect(languageOf("CMakeLists.txt")).toBe("cmake");
  for (const f of [".gitignore", ".gitattributes", ".editorconfig", ".npmrc"]) expect(languageOf(f), f).toBe("ini");
  expect(languageOf(".env")).toBe("properties");
  expect(languageOf("app/.env.local")).toBe("properties");
  for (const f of [".bashrc", ".zshrc", ".profile", ".bash_profile", ".envrc"]) expect(languageOf(f), f).toBe("shell");
});

it("matches file names case-insensitively", () => {
  expect(languageOf("MAKEFILE")).toBe("shell");
  expect(languageOf("dockerfile")).toBe("dockerfile");
  expect(languageOf("cmakelists.txt")).toBe("cmake");
});

it("reads a shebang for extensionless files", () => {
  expect(languageOf("bin/run", "#!/usr/bin/env bash")).toBe("shell");
  expect(languageOf("bin/run", "#!/bin/sh")).toBe("shell");
  expect(languageOf("bin/run", "#!/bin/zsh -e")).toBe("shell");
  expect(languageOf("bin/run", "#!/usr/bin/env python3")).toBe("python");
  expect(languageOf("bin/run", "#!/usr/bin/python")).toBe("python");
  expect(languageOf("bin/run", "#!/usr/bin/env node")).toBe("js");
  expect(languageOf("bin/run", "#!/usr/bin/perl")).toBeNull();
  expect(languageOf("bin/run", "echo hi")).toBeNull();
  // A real extension wins over the first line.
  expect(languageOf("a.txt", "#!/bin/sh")).toBeNull();
  expect(languageOf("a.py", "#!/bin/sh")).toBe("python");
});

it("loads every language it names", async () => {
  const all: Language[] = [
    "js", "ts", "rust", "json", "css", "html", "python", "yaml", "markdown",
    "go", "java", "cpp", "csharp", "php", "sql", "xml", "shell", "toml", "ini", "dockerfile",
    "lua", "ruby", "swift", "kotlin", "diff", "properties", "groovy", "cmake",
  ];
  for (const lang of all) expect(await loadLanguage(lang), lang).toBeTruthy();
});
