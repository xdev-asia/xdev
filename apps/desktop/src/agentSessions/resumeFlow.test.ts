import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/api";
import { createMockApi } from "@/mockApi";
import { Sessions } from "@/workspace/sessions";
import { confirmResume, startResume } from "./resumeFlow";

const row = (worktree: string | null, cwd: string | null, homeId = "own-claude"): SessionRow => ({
  session: { key: `${homeId}:abc`, id: "abc", homeId, agent: "claude", cwd, branch: null, title: "Fix it", model: null, first: 1, last: 2, messages: 2 },
  worktree,
  repo: worktree,
  resumable: true,
});

describe("startResume", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });
  const live = () => (sessions = new Sessions(createMockApi({})));

  it("opens the tab in the row's worktree, titled with the session, and asks nothing", () => {
    const s = live();
    const ask = vi.fn();
    const tab = startResume(s, row("/demo/wt/a", "/demo/wt/a/src"), "/demo/wt/b", ask);
    expect(tab).toMatchObject({ worktree: "/demo/wt/a", profileId: "claude", resumeOf: "abc", title: "Fix it" });
    expect(ask).not.toHaveBeenCalled();
    expect(s.tabs("/demo/wt/b")).toEqual([]);
  });

  it("asks, and opens nothing, when the folder is not the one on screen", () => {
    const s = live();
    const ask = vi.fn();
    expect(startResume(s, row(null, "/tmp/scratch"), "/demo/wt/b", ask)).toBeNull();
    expect(ask).toHaveBeenCalledWith({ row: expect.anything(), worktree: "/demo/wt/b" });
    expect(s.tabs("/demo/wt/b")).toEqual([]);
    // Once confirmed it opens in the worktree on screen.
    expect(confirmResume(s, ask.mock.calls[0][0])).toMatchObject({ worktree: "/demo/wt/b", resumeOf: "abc" });
  });

  it("does not ask when the session's folder is inside the worktree on screen", () => {
    const s = live();
    const ask = vi.fn();
    expect(startResume(s, row(null, "/demo/wt/b/src"), "/demo/wt/b", ask)).not.toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("does nothing without a target", () => {
    const s = live();
    const ask = vi.fn();
    expect(startResume(s, row(null, "/tmp/x"), null, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("an account home resumes under that account", () => {
    const s = live();
    expect(startResume(s, row("/demo/wt/a", "/demo/wt/a", "acct-work"), null, vi.fn())).toMatchObject({ account: "work" });
  });
});
