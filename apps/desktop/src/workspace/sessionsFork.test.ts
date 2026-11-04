import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("Sessions.fork", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  it("opens a tab with forkOf set, no resumeOf and no session id yet", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    await api.ptyApprove("claude", null, "src-1", true);
    const tab = live.fork(A, "claude", null, "src-1", "Fix the parser");
    expect(tab).toMatchObject({ worktree: A, profileId: "claude", agent: true, forkOf: "src-1", resumeOf: null, agentSession: null, title: "Fix the parser" });
    await tab.client.start(A, "claude", 80, 24, () => {});
    // The launch resumes the source and forks it.
    expect(spawn.mock.calls[0][7]).toBe("src-1");
    expect(spawn.mock.calls[0][8]).toBe(true);
    expect(live.tabs(A).map((t) => t.id)).toEqual([tab.id]);
  });

  it("a plain resume does not fork", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    await api.ptyApprove("claude", null, "src-1");
    const tab = live.resume(A, "claude", null, "src-1");
    expect(tab.forkOf).toBeNull();
    await tab.client.start(A, "claude", 80, 24, () => {});
    expect(spawn.mock.calls[0][8]).toBe(false);
  });

  it("the snapshot saves agentSession only once the hooks reported it", () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.fork(A, "claude", null, "src-1");
    const saved = () => {
      const t = Object.values(live.snapshot().worktrees[A]!.tabs)[0]!;
      return t.kind === "terminal" ? t.agentSession : "not a terminal";
    };
    expect(saved()).toBeNull();
    api.__hook(tab.id, "prompt", undefined, "new-2");
    expect(saved()).toBe("new-2");
  });

  it("a restart with a known new id resumes that id, not a second fork; without one it starts fresh", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    await api.ptyApprove("claude", null, "new-2");
    const known = live.fork(A, "claude", null, "src-1");
    api.__hook(known.id, "prompt", undefined, "new-2");
    const again = live.restart(known.id)!;
    expect(again).toMatchObject({ forkOf: null, resumeOf: "new-2", agentSession: "new-2" });
    await again.client.start(A, "claude", 80, 24, () => {});
    expect(spawn.mock.calls.at(-1)![7]).toBe("new-2");
    expect(spawn.mock.calls.at(-1)![8]).toBe(false);

    const unknown = live.fork(A, "claude", null, "src-1");
    const fresh = live.restart(unknown.id)!;
    expect(fresh).toMatchObject({ forkOf: null, resumeOf: null, agentSession: null });
  });
});
