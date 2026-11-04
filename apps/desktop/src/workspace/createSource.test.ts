import { describe, expect, it } from "vitest";
import type { PrSummary, WorktreeView } from "@/api";
import { localBranches, prWorkItem, prWorktreeName, sparseDirs } from "./createSource";

const pr = (patch: Partial<PrSummary> = {}): PrSummary => ({
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  state: "open",
  title: "Fix the footer meter",
  base: "main",
  head: "fix-footer",
  author: "octocat",
  updatedAt: "2026-11-03T10:00:00Z",
  fork: false,
  ...patch,
});

describe("sparseDirs", () => {
  it("reads one folder per line, normalized, without duplicates or blanks", () => {
    expect(sparseDirs("src\n\n ./docs/api/ \r\napps\\desktop\nsrc\n")).toEqual(["src", "docs/api", "apps/desktop"]);
    expect(sparseDirs("")).toEqual([]);
  });
  it("refuses a path that leaves the repo or looks like a flag", () => {
    for (const bad of ["../out", "a/../b", "/abs", "C:/x", "-x", "a//b", "a/./b", "a\u0001b"]) {
      expect(sparseDirs(bad), bad).toBe("bad");
    }
  });
  it("accepts 50 folders and refuses 51", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join("\n");
    expect(sparseDirs(lines(50))).toHaveLength(50);
    expect(sparseDirs(lines(51))).toBe("bad");
  });
});

describe("localBranches", () => {
  const wt = (branch: string | null) => ({ branch }) as WorktreeView;
  it("leaves out remote branches and the ones a worktree has", () => {
    const branches = [
      { name: "main", remote: false },
      { name: "develop", remote: false },
      { name: "origin/develop", remote: true },
      { name: "feat/x", remote: false },
    ];
    expect(localBranches(branches, [wt("main"), wt(null)])).toEqual(["develop", "feat/x"]);
    expect(localBranches([], [wt("main")])).toEqual([]);
  });
});

describe("pull request helpers", () => {
  it("makes a work item with the title", () => {
    expect(prWorkItem(pr())).toEqual({ kind: "pr", url: "https://github.com/acme/app/pull/12", title: "Fix the footer meter" });
  });
  it("names the worktree pr-<n>-<title>, cut to the name limit, or pr-<n> alone", () => {
    expect(prWorktreeName(pr())).toBe("pr-12-fix-the-footer-meter");
    expect(prWorktreeName(pr({ title: "!!!" }))).toBe("pr-12");
    expect(prWorktreeName(pr({ title: "Đổi màu nền" }))).toBe("pr-12-doi-mau-nen");
    expect(prWorktreeName(pr({ title: "a".repeat(80) })).length).toBeLessThanOrEqual(43);
  });
});
