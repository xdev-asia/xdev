import { describe, expect, it } from "vitest";
import type { SessionRow } from "@/api";
import { resumeChoices, resumeDestination, resumeProfile, resumeTarget, sessionWorktreeDiffers } from "./resumeTarget";

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

describe("resumeDestination", () => {
  it("here is the worktree on screen, and asks when the session's folder is outside it", () => {
    expect(resumeDestination(row(), "/demo/wt/other", "here")).toEqual({ worktree: "/demo/wt/other", mismatch: true });
    expect(resumeDestination(row({ cwd: "/demo/wt/other/src" }), "/demo/wt/other", "here")).toEqual({ worktree: "/demo/wt/other", mismatch: false });
    expect(resumeDestination(row(), null, "here")).toEqual({ worktree: null, mismatch: false });
  });

  it("session is the row's own worktree only when known and different", () => {
    expect(resumeDestination(row(), "/demo/wt/other", "session")).toEqual({ worktree: "/demo/wt/xdev-oak", mismatch: false });
    expect(resumeDestination(row(), null, "session").worktree).toBe("/demo/wt/xdev-oak");
    expect(resumeDestination(row(), "/demo/wt/xdev-oak/", "session").worktree).toBeNull();
    expect(resumeDestination(row({ worktree: null }), "/demo/wt/other", "session").worktree).toBeNull();
  });

  it("a new tab follows the default target", () => {
    expect(resumeDestination(row(), "/demo/wt/other", "newTab")).toEqual(resumeTarget(row(), "/demo/wt/other"));
    expect(resumeDestination(row({ worktree: null }), "/demo/wt/other", "newTab")).toEqual({ worktree: "/demo/wt/other", mismatch: true });
  });

  it("lists which destinations are enabled", () => {
    expect(resumeChoices(row(), "/demo/wt/xdev-oak")).toEqual([
      { dest: "here", enabled: true },
      { dest: "session", enabled: false },
      { dest: "newTab", enabled: true },
    ]);
    expect(resumeChoices(row({ worktree: null }), null).map((c) => c.enabled)).toEqual([false, false, false]);
    expect(sessionWorktreeDiffers(row(), "/demo/wt/x")).toBe(true);
  });
});
