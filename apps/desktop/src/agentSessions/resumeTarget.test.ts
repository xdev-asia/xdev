import { describe, expect, it } from "vitest";
import type { SessionRow } from "@/api";
import { resumeProfile, resumeTarget } from "./resumeTarget";

const row = (over: Partial<SessionRow> & { cwd?: string | null; homeId?: string; agent?: "claude" | "codex" } = {}): SessionRow => ({
  session: {
    key: "k",
    id: "abc",
    homeId: over.homeId ?? "own-claude",
    agent: over.agent ?? "claude",
    cwd: over.cwd === undefined ? "/demo/wt/xdev-oak" : over.cwd,
    branch: null,
    title: "t",
    model: null,
    first: 0,
    last: 1,
    messages: 2,
  },
  worktree: over.worktree === undefined ? "/demo/wt/xdev-oak" : over.worktree,
  repo: "/demo/xdev",
  resumable: over.resumable ?? true,
});

describe("resumeTarget", () => {
  it("uses the row's worktree without asking, even when another one is on screen", () => {
    expect(resumeTarget(row(), "/demo/wt/xdev-elm")).toEqual({ worktree: "/demo/wt/xdev-oak", mismatch: false });
  });

  it("a row with no worktree falls to the one on screen and asks, as the folder differs", () => {
    expect(resumeTarget(row({ worktree: null, cwd: "/demo/tmp/scratch" }), "/demo/wt/xdev-elm")).toEqual({
      worktree: "/demo/wt/xdev-elm",
      mismatch: true,
    });
  });

  it("does not ask when the session's folder is inside the worktree on screen", () => {
    expect(resumeTarget(row({ worktree: null, cwd: "/demo/wt/xdev-elm/src" }), "/demo/wt/xdev-elm")).toEqual({
      worktree: "/demo/wt/xdev-elm",
      mismatch: false,
    });
  });

  it("has no target when nothing is on screen", () => {
    expect(resumeTarget(row({ worktree: null }), null)).toEqual({ worktree: null, mismatch: false });
  });
});

describe("resumeProfile", () => {
  it("is the agent's default profile and the own home", () => {
    expect(resumeProfile(row({ agent: "codex", homeId: "own-codex" }))).toEqual({ profileId: "codex", account: null });
  });

  it("an account home resumes under that account", () => {
    expect(resumeProfile(row({ homeId: "acct-work" }))).toEqual({ profileId: "claude", account: "work" });
  });
});
