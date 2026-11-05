import { describe, expect, it } from "vitest";
import type { PrSummary, ReviewBranch, WorktreeView } from "@/api";
import { baseRefOptions, localBranches, prWorkItem, prWorktreeName, sparseDirs } from "./createSource";

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

describe("baseRefOptions", () => {
  const b = (name: string, remote = false): ReviewBranch => ({ name, remote });
  const names = (o: { name: string }[]) => o.map((x) => x.name);

  it("puts the default first and flags it", () => {
    const { options } = baseRefOptions([b("alpha"), b("main"), b("beta")], "main", "");
    expect(options[0]).toEqual({ name: "main", isDefault: true });
    expect(names(options)).toEqual(["main", "alpha", "beta"]);
    expect(options.filter((o) => o.isDefault)).toHaveLength(1);
  });

  it("keeps a local and a remote name apart but drops the same name twice", () => {
    const { options } = baseRefOptions([b("main"), b("origin/main", true), b("dev"), b("dev", true)], null, "");
    expect(names(options)).toEqual(["", "dev", "main", "origin/main"]);
  });

  it("sorts with localeCompare", () => {
    const { options } = baseRefOptions([b("zed"), b("alpha"), b("mid")], null, "");
    expect(names(options.slice(1))).toEqual(["alpha", "mid", "zed"]);
  });

  it("filters by a case-insensitive substring", () => {
    const { options } = baseRefOptions([b("feat/Login"), b("main"), b("fix/login-bug")], "main", "LOGIN");
    expect(names(options)).toEqual(["feat/Login", "fix/login-bug"]);
  });

  it("limits to 30 rows, the default included", () => {
    const many = Array.from({ length: 50 }, (_, i) => b(`b${String(i).padStart(2, "0")}`));
    const { options } = baseRefOptions(many, "main", "");
    expect(options).toHaveLength(30);
    expect(options[0].isDefault).toBe(true);
  });

  it("offers the typed text when no name matches exactly", () => {
    expect(baseRefOptions([b("main")], "main", " v1.2 ").typed).toBe("v1.2");
    expect(baseRefOptions([b("main")], "main", "main").typed).toBeNull();
    expect(baseRefOptions([b("main")], "main", "  ").typed).toBeNull();
  });
});
