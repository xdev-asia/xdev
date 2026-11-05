import { afterEach, expect, it, vi } from "vitest";
import { ancestorsOf, loadReveal, revealOpen, saveReveal } from "./treeReveal";

afterEach(() => vi.unstubAllGlobals());

it("lists the folders above a file, outermost first", () => {
  expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
  expect(ancestorsOf("c.ts")).toEqual([]);
});

it("adds only the folders that are not open, and keeps the array when none is missing", () => {
  expect(revealOpen(["x"], "a/b/c.ts")).toEqual(["x", "a", "a/b"]);
  expect(revealOpen(["a"], "a/b/c.ts")).toEqual(["a", "a/b"]);
  const open = ["a", "a/b"];
  expect(revealOpen(open, "a/b/c.ts")).toBe(open);
  expect(revealOpen(open, "top.ts")).toBe(open);
});

it("follows the active file unless it was turned off; unreadable storage means on", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  expect(loadReveal()).toBe(true);
  saveReveal(false);
  expect(loadReveal()).toBe(false);
  saveReveal(true);
  expect(loadReveal()).toBe(true);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
  expect(loadReveal()).toBe(true);
  expect(() => saveReveal(false)).not.toThrow();
});
