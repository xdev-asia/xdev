import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("Sessions.resume", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  it("opens a tab whose pty is spawned with the session id", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    await api.ptyApprove("claude", null);
    const tab = live.resume(A, "claude", null, "0b1e6f3a-demo-0001");
    expect(tab).toMatchObject({ worktree: A, profileId: "claude", agent: true, resumeOf: "0b1e6f3a-demo-0001" });
    await tab.client.start(A, "claude", 80, 24, () => {});
    expect(spawn.mock.calls[0][7]).toBe("0b1e6f3a-demo-0001");
  });

  it("a plain open has no resumeOf and spawns without a resume id", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    const tab = live.open(A, "shell");
    await tab.client.start(A, "shell", 80, 24, () => {});
    expect(tab.resumeOf).toBeNull();
    expect(spawn.mock.calls[0][7]).toBeUndefined();
  });

  it("titles the tab with the session title until the terminal sets its own", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.resume(A, "claude", null, "abc", "Fix the parser");
    expect(live.tabs(A)[0]).toMatchObject({ title: "Fix the parser", renamed: false });
    live.noteTitle(tab.id, "Claude Code");
    expect(live.tabs(A)[0].title).toBe("Claude Code");
  });

  it("a hand name is kept over the session title", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.resume(A, "claude", null, "abc", "Fix the parser");
    live.rename(tab.id, "mine");
    live.noteTitle(tab.id, "Claude Code");
    expect(live.tabs(A)[0].title).toBe("mine");
  });

  it("restart resumes the same session again", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    await api.ptyApprove("claude", null);
    const tab = live.resume(A, "claude", "work", "abc", "t");
    const next = live.restart(tab.id)!;
    expect(next).toMatchObject({ resumeOf: "abc", account: "work", title: "t" });
    await next.client.start(A, "claude", 80, 24, () => {}, "work");
    expect(spawn.mock.calls[0][7]).toBe("abc");
  });

  it("finds a tab by its pty id", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.open(A, "claude");
    expect(live.tab(tab.id)).toBe(tab);
    expect(live.tab("nope")).toBeNull();
  });
});

describe("Sessions.resumed", () => {
  it("lists the tabs that resumed a session", () => {
    const live = new Sessions(createMockApi({}));
    live.open(A, "claude");
    const tab = live.resume(A, "claude", null, "abc");
    expect(live.resumed()).toEqual([tab]);
    live.dispose();
  });
});

describe("Sessions agent session id", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  it("a hook with a session id sets agentSession, and a later different id replaces it", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude");
    await Promise.resolve();
    expect(live.tabs(A)[0].agentSession).toBeNull();
    api.__hook(tab.id, "prompt", undefined, "abc");
    expect(live.tabs(A)[0].agentSession).toBe("abc");
    api.__hook(tab.id, "turn-done");
    expect(live.tabs(A)[0].agentSession).toBe("abc");
    api.__hook(tab.id, "prompt", undefined, "def");
    expect(live.tabs(A)[0].agentSession).toBe("def");
  });

  it("a resumed tab starts with the id and an open stamps openedAt", () => {
    const live = (sessions = new Sessions(createMockApi({}), () => 4242));
    expect(live.resume(A, "claude", null, "xyz").agentSession).toBe("xyz");
    expect(live.open(A, "shell")).toMatchObject({ agentSession: null, openedAt: 4242 });
  });

  it("restart keeps the agentSession a hook set, and the snapshot still has it", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude");
    await Promise.resolve();
    api.__hook(tab.id, "prompt", undefined, "abc");
    const next = live.restart(tab.id)!;
    expect(next.id).not.toBe(tab.id);
    expect(live.tabs(A)[0].agentSession).toBe("abc");
    const snap = live.snapshot().worktrees[A].tabs.t1;
    expect(snap).toMatchObject({ kind: "terminal", agentSession: "abc" });
  });
});
