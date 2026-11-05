import { expect, it } from "vitest";
import { matchFiles } from "./treeFilter";

const files = ["src/App.tsx", "src/deep/app.test.ts", "README.md", "docs/guide/Happy.md", "src/lib/util.ts"];

it("matches the file name as a case-insensitive substring, names that start with it first", () => {
  const { hits, more } = matchFiles(files, "APP");
  expect(hits.map((h) => h.rel)).toEqual(["src/App.tsx", "src/deep/app.test.ts", "docs/guide/Happy.md"]);
  expect(more).toBe(false);
});

it("gives the name and the folder of each hit", () => {
  expect(matchFiles(files, "util").hits).toEqual([{ rel: "src/lib/util.ts", name: "util.ts", dir: "src/lib" }]);
  expect(matchFiles(files, "readme").hits[0]).toEqual({ rel: "README.md", name: "README.md", dir: "" });
});

it("does not match folder names or scattered letters", () => {
  expect(matchFiles(files, "guide").hits).toEqual([]);
  expect(matchFiles(files, "aptsx").hits).toEqual([]);
});

it("a blank query matches nothing", () => {
  expect(matchFiles(files, "  ").hits).toEqual([]);
});

it("keeps at most the limit and says there were more", () => {
  const many = Array.from({ length: 5 }, (_, i) => `d/f${i}.ts`);
  expect(matchFiles(many, "f", 3)).toMatchObject({ more: true });
  expect(matchFiles(many, "f", 3).hits).toHaveLength(3);
});
