import { expect, it } from "vitest";
import { rankFiles, splitLine } from "./quickOpen";
import { RECENT_FILES_KEY, RecentFiles } from "./recentFiles";

const FILES = ["apps/x/happy.ts", "src/App.tsx", "README.md", "src/util/zzz.ts"];

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

it("app ranks App.tsx above apps/x/happy.ts, with ranges in rel", () => {
  const out = rankFiles(FILES, "app", []);
  expect(out.map((r) => r.rel)).toEqual(["src/App.tsx", "apps/x/happy.ts"]);
  expect(out[0].hits).toEqual([[4, 7]]);
});

it("a query must match every word", () => {
  expect(rankFiles(FILES, "util zzz", []).map((r) => r.rel)).toEqual(["src/util/zzz.ts"]);
  expect(rankFiles(FILES, "util nope", [])).toEqual([]);
});

it("an empty query lists recent first, then path order", () => {
  const out = rankFiles(FILES, "", ["README.md", "gone.ts", "src/App.tsx"]);
  expect(out.map((r) => r.rel)).toEqual(["README.md", "src/App.tsx", "apps/x/happy.ts", "src/util/zzz.ts"]);
});

it("the recent bonus only applies to matching files", () => {
  const files = ["a/foo1.ts", "b/foo2.ts", "c/other.ts"];
  expect(rankFiles(files, "foo", ["b/foo2.ts"]).map((r) => r.rel)).toEqual(["b/foo2.ts", "a/foo1.ts"]);
  expect(rankFiles(files, "foo", ["c/other.ts"]).map((r) => r.rel)).toEqual(["a/foo1.ts", "b/foo2.ts"]);
});

it("splitLine reads a :n suffix", () => {
  expect(splitLine("App.tsx:42")).toEqual({ query: "App.tsx", line: 42 });
  expect(splitLine("App.tsx:0")).toEqual({ query: "App.tsx:0" });
  expect(splitLine("App.tsx")).toEqual({ query: "App.tsx" });
});

it("recent files are per worktree, newest first, capped and persisted", () => {
  const store = memory();
  const r = new RecentFiles(store);
  r.touch("/a", "x.ts");
  r.touch("/a", "y.ts");
  r.touch("/a", "x.ts");
  r.touch("/b", "z.ts");
  expect(r.list("/a")).toEqual(["x.ts", "y.ts"]);
  expect(r.list("/b")).toEqual(["z.ts"]);
  expect(r.list("/c")).toEqual([]);
  expect(store.getItem(RECENT_FILES_KEY)).toContain("z.ts");
  expect(new RecentFiles(store).list("/a")).toEqual(["x.ts", "y.ts"]);
  for (let i = 0; i < 60; i++) r.touch("/a", `f${i}`);
  expect(r.list("/a")).toHaveLength(50);
  expect(r.list("/a")[0]).toBe("f59");
});
