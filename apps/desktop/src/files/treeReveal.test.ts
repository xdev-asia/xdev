import { afterEach, expect, it, vi } from "vitest";
import { ancestorsOf, loadReveal, loadShowIgnored, onTreeReveal, requestTreeReveal, revealOpen, saveReveal, saveShowIgnored } from "./treeReveal";

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

it("shows ignored files unless turned off", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  expect(loadShowIgnored()).toBe(true);
  saveShowIgnored(false);
  expect(loadShowIgnored()).toBe(false);
  saveShowIgnored(true);
  expect(loadShowIgnored()).toBe(true);
});

it("a reveal request reaches the listeners until they stop", () => {
  const seen: string[] = [];
  const off = onTreeReveal((r) => seen.push(`${r.worktree}:${r.rel}`));
  requestTreeReveal("/wt", "a/b.ts");
  off();
  requestTreeReveal("/wt", "c.ts");
  expect(seen).toEqual(["/wt:a/b.ts"]);
});
