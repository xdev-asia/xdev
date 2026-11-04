import { expect, it } from "vitest";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import type { WorktreeView } from "@/api";
import { childrenOf, parentCandidates, parentOf } from "./lineage";

const base = DEMO_WORKSPACE.repos[0].worktrees[0];
const make = (path: string, over: Partial<WorktreeView> = {}): WorktreeView => ({ ...base, path, primary: false, parent: null, ...over });

const main = make("/r/main", { primary: true });
const a = make("/r/a");
const b = make("/r/b");
const c = make("/r/c", { parent: "/r/a" });
const all = [main, a, b, c];

it("offers the top-level linked worktrees, never itself, the primary checkout or a child", () => {
  expect(parentCandidates(b, all).map((w) => w.path)).toEqual(["/r/a"]);
});

it("leaves out the current parent", () => {
  expect(parentCandidates(c, all).map((w) => w.path)).toEqual(["/r/b"]);
});

it("offers nothing to a worktree that has children", () => {
  expect(parentCandidates(a, all)).toEqual([]);
});

it("finds children and the parent", () => {
  expect(childrenOf(a, all).map((w) => w.path)).toEqual(["/r/c"]);
  expect(childrenOf(b, all)).toEqual([]);
  expect(parentOf(c, all)?.path).toBe("/r/a");
  expect(parentOf(a, all)).toBeNull();
  expect(parentOf(make("/r/d", { parent: "/gone" }), all)).toBeNull();
});
