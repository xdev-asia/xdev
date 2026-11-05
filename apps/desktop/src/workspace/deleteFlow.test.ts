import { expect, it } from "vitest";
import type { KeptBranch } from "@/api";
import { keptOutcome, removeArgs, showsDontAsk } from "./deleteFlow";

const kept = (branch: string): KeptBranch => ({ repoId: "r", branch, path: `/x/${branch}`, keptMs: 1, reason: "deleted", title: null, comment: "", status: null, item: null });

it("force is on for a dirty worktree or when Always force is set; unmerged follows its own switch", () => {
  expect(removeArgs(false, { alwaysForce: false, alwaysDeleteKept: false })).toEqual({ force: false, deleteUnmerged: false });
  expect(removeArgs(true, { alwaysForce: false, alwaysDeleteKept: false })).toEqual({ force: true, deleteUnmerged: false });
  expect(removeArgs(false, { alwaysForce: true, alwaysDeleteKept: true })).toEqual({ force: true, deleteUnmerged: true });
});

it("the Don't ask again tick shows for one clean worktree without children", () => {
  expect(showsDontAsk({ dirty: false, children: 0, count: 1 })).toBe(true);
  expect(showsDontAsk({ dirty: true, children: 0, count: 1 })).toBe(false);
  expect(showsDontAsk({ dirty: false, children: 2, count: 1 })).toBe(false);
  expect(showsDontAsk({ dirty: false, children: 0, count: 2 })).toBe(false);
});

it("one kept branch offers Delete branch, several offer a review, none says nothing", () => {
  expect(keptOutcome([])).toBeNull();
  expect(keptOutcome([kept("a")])).toEqual({ kind: "one", kept: kept("a") });
  expect(keptOutcome([kept("a"), kept("b")])).toEqual({ kind: "many", count: 2 });
});
