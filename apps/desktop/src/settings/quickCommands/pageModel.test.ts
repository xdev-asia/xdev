import { expect, it } from "vitest";
import type { FileCommands, QuickCommand } from "@/api";
import { buildGroups, moveTarget } from "./pageModel";

const term = (id: string, label: string, scope: QuickCommand["scope"], command = "x"): QuickCommand => ({
  id,
  label,
  scope,
  action: { type: "terminal", command, appendEnter: true },
});
const items = [
  term("g1", "Git status", { type: "global" }, "git status"),
  term("a1", "Tests", { type: "repo", repo: "/a" }, "cargo test"),
  term("g2", "Lint", { type: "global" }, "pnpm lint"),
  term("a2", "Build", { type: "repo", repo: "/a" }),
  term("z1", "Old", { type: "repo", repo: "/gone" }),
];
const repos = [{ path: "/a", name: "alpha" }, { path: "/b", name: "beta" }];
const file: FileCommands = { trusted: false, hash: "h", errors: [], commands: [{ label: "Check", action: { type: "terminal", command: "make check", appendEnter: true } }] };

it("groups global, then each repo with its xdev.toml commands, then unknown repos", () => {
  const g = buildGroups(items, repos, { "/a": file }, "", "all");
  expect(g.map((x) => x.id)).toEqual(["global", "repo:/a", "file:/a", "unknown"]);
});

it("the scope filter keeps one scope; unknown repos only show under All", () => {
  expect(buildGroups(items, repos, {}, "", "global").map((x) => x.id)).toEqual(["global"]);
  expect(buildGroups(items, repos, { "/a": file }, "", "/a").map((x) => x.id)).toEqual(["repo:/a", "file:/a"]);
});

it("search matches label and text, in file commands too", () => {
  expect(buildGroups(items, repos, {}, "cargo", "all").map((x) => x.id)).toEqual(["repo:/a"]);
  const g = buildGroups(items, repos, { "/a": file }, "check", "all");
  expect(g.map((x) => x.id)).toEqual(["file:/a"]);
});

it("moves inside the scope only and stops at the edge", () => {
  expect(moveTarget(items, "g1", 1)).toBe(1);
  expect(moveTarget(items, "g1", -1)).toBeNull();
  expect(moveTarget(items, "a2", -1)).toBe(0);
  expect(moveTarget(items, "a2", 1)).toBeNull();
  expect(moveTarget(items, "nope", 1)).toBeNull();
});
