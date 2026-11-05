import { describe, expect, it } from "vitest";
import { captureEntries, entrySummary, resolveWorktree } from "./sets";

const tab = (id: string, over: Record<string, unknown> = {}) => ({ id, worktree: "/w", profileId: "claude", agent: true, exitCode: undefined, ...over });

describe("captureEntries", () => {
  it("turns agent tabs into agent entries and others into shell entries", () => {
    const out = captureEntries([tab("1"), tab("2", { profileId: "shell:bash", agent: false })], "/w", () => null);
    expect(out.map((e) => e.target)).toEqual([
      { type: "agent", profile: "claude" },
      { type: "shell", command: "", shell: "shell:bash" },
    ]);
    expect(out[0].worktree).toEqual({ type: "current" });
  });

  it("leaves out exited tabs and tabs of an unknown worktree, names the others", () => {
    const out = captureEntries(
      [tab("1", { exitCode: 0 }), tab("2", { worktree: "/x" }), tab("3", { worktree: "/y" })],
      "/w",
      (p) => (p === "/y" ? "feature" : null),
    );
    expect(out).toHaveLength(1);
    expect(out[0].worktree).toEqual({ type: "named", name: "feature" });
  });

  it("carries the startup sequence a tab was opened with", () => {
    const steps = [{ command: "ls", wait: { type: "none" as const } }];
    expect(captureEntries([tab("1")], "/w", () => null, () => steps)[0].startup).toEqual(steps);
  });

  it("keeps at most 32 entries", () => {
    const many = Array.from({ length: 40 }, (_, i) => tab(String(i)));
    expect(captureEntries(many, "/w", () => null)).toHaveLength(32);
  });
});

describe("resolveWorktree", () => {
  const list = [{ path: "/a", label: "Main" }];
  it("resolves current and named worktrees, null when unknown", () => {
    expect(resolveWorktree({ type: "current" }, "/w", list)).toBe("/w");
    expect(resolveWorktree({ type: "named", name: "main" }, "/w", list)).toBe("/a");
    expect(resolveWorktree({ type: "named", name: "nope" }, "/w", list)).toBeNull();
  });
});

describe("entrySummary", () => {
  it("shows the agent, the first command line, or the shell word", () => {
    const base = { worktree: { type: "current" as const }, startup: [] };
    expect(entrySummary({ ...base, target: { type: "agent", profile: "claude" } }, "shell")).toBe("claude");
    expect(entrySummary({ ...base, target: { type: "shell", command: "ls\nmore", shell: null } }, "shell")).toBe("ls");
    expect(entrySummary({ ...base, target: { type: "shell", command: " ", shell: null } }, "shell")).toBe("shell");
  });
});
