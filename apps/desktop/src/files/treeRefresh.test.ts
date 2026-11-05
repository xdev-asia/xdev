import { expect, it } from "vitest";
import type { FsEvent } from "@/api";
import { dirsToReload } from "./treeRefresh";

const ev = (kind: FsEvent["kind"], rel: string, dir: boolean | null = false): FsEvent => ({ kind, rel, dir });
const LOADED = new Set(["", "src", "src/deep"]);

it("a root entry reloads the root", () => {
  expect(dirsToReload([ev("create", "a.txt")], LOADED)).toEqual([""]);
});

it("a nested entry reloads its parent only when that folder is loaded", () => {
  expect(dirsToReload([ev("delete", "src/deep/x.ts", null)], LOADED)).toEqual(["src/deep"]);
  expect(dirsToReload([ev("create", "docs/new.md")], LOADED)).toEqual([]);
});

it("a created or deleted folder reloads its parent", () => {
  expect(dirsToReload([ev("create", "src/lib", true)], LOADED)).toEqual(["src"]);
});

it("an update to a file reloads nothing", () => {
  expect(dirsToReload([ev("update", "src/a.ts")], LOADED)).toEqual([]);
});

it("an overflow reloads everything", () => {
  expect(dirsToReload([ev("create", "a"), ev("overflow", "", null)], LOADED)).toBe("all");
});

it("a folder is listed once", () => {
  const out = dirsToReload([ev("create", "src/a.ts"), ev("delete", "src/b.ts", null), ev("create", "c")], LOADED);
  expect(out).toEqual(["src", ""]);
});
