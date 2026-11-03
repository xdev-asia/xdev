import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "../mockApi";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";

type Profile = "shell" | "claude" | "codex";

async function spawn(sessions: Sessions, worktree: string, profile: Profile) {
  const tab = sessions.open(worktree, profile);
  await tab.client.start(worktree, profile, 80, 24, () => {});
  return tab;
}

describe("Sessions", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    vi.useRealTimers();
  });

  it("opens a tab with the worktree as cwd", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const spawnSpy = vi.spyOn(api, "ptySpawn");
    const tab = live.open(A, "shell");
    await tab.client.start(A, "shell", 80, 24, () => {});
    expect(spawnSpy.mock.calls[0].slice(0, 3)).toEqual([tab.id, A, "shell"]);
    expect(tab).toMatchObject({ worktree: A, profileId: "shell", agent: false, status: "idle" });
    expect(live.open(A, "claude").agent).toBe(true);
    expect(live.tabs(A)).toHaveLength(2);
    expect(live.tabs(B)).toEqual([]);
  });

  it("removing_a_worktree_kills_its_sessions_first", async () => {
    const api = createMockApi({});
    await api.ptyApprove("claude");
    const live = (sessions = new Sessions(api));
    const a1 = await spawn(live, A, "shell");
    const a2 = await spawn(live, A, "claude");
    const b1 = await spawn(live, B, "shell");
    const kill = vi.spyOn(api, "ptyKill");
    const exited: string[] = [];
    await api.onPtyExit((e) => exited.push(e.id));

    await live.closeWorktree(A);

    expect(kill.mock.calls.map((c) => c[0]).sort()).toEqual([a1.id, a2.id].sort());
    expect(kill).not.toHaveBeenCalledWith(b1.id);
    // closeWorktree resolved only after both exits arrived.
    expect(exited.sort()).toEqual([a1.id, a2.id].sort());
    expect(live.tabs(A)).toEqual([]);
    expect(live.tabs(B).map((t) => t.id)).toEqual([b1.id]);
  });

  it("gives up waiting for an exit after 5 seconds", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    live.open(A, "shell");
    vi.spyOn(api, "ptyKill").mockResolvedValue();
    let done = false;
    const closing = live.closeWorktree(A).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(done).toBe(true);
    expect(live.tabs(A)).toEqual([]);
  });

  it("shell tabs do not count for the dot", () => {
    const live = (sessions = new Sessions(createMockApi({}), () => 1_000));
    const shell = live.open(A, "shell");
    live.noteOutput(shell.id, 10);
    expect(live.tabs(A)[0].status).toBe("working");
    expect(live.dot(A)).toBeNull();
    const agent = live.open(A, "claude");
    expect(live.dot(A)).toBe("idle");
    live.noteOutput(agent.id, 10);
    expect(live.dot(A)).toBe("working");
  });

  it("output then quiet goes idle on the 1 second tick", () => {
    vi.useFakeTimers();
    let t = 10_000;
    const live = (sessions = new Sessions(createMockApi({}), () => t));
    const tab = live.open(A, "claude");
    const seen: string[] = [];
    live.subscribe(() => seen.push(live.dot(A) ?? "none"));
    live.noteOutput(tab.id, 5);
    expect(live.dot(A)).toBe("working");
    t += 2000;
    vi.advanceTimersByTime(2000);
    expect(live.dot(A)).toBe("working");
    t += 1000;
    vi.advanceTimersByTime(1000);
    expect(live.dot(A)).toBe("idle");
    expect(seen).toEqual(["working", "idle"]);
    // The interval stops once nothing is working.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("typing echo does not make a tab work, and the exit event ends it", async () => {
    let t = 1_000;
    const live = (sessions = new Sessions(createMockApi({}), () => t));
    const tab = live.open(A, "shell");
    await tab.client.start(A, "shell", 80, 24, () => {});
    live.noteInput(tab.id);
    t += 100;
    live.noteOutput(tab.id, 1);
    expect(live.tabs(A)[0].status).toBe("idle");
    await tab.client.input("exit\r");
    expect(live.tabs(A)[0].status).toBe("exited");
  });

  it("gives useSyncExternalStore a stable snapshot until something changes", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    live.open(A, "shell");
    const first = live.tabs(A);
    expect(live.tabs(A)).toBe(first);
    live.open(A, "claude");
    expect(live.tabs(A)).not.toBe(first);
  });

  it("close kills one tab and subscribers hear about it", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const kill = vi.spyOn(api, "ptyKill");
    const tab = live.open(A, "shell");
    const heard = vi.fn();
    live.subscribe(heard);
    await live.close(tab.id);
    expect(kill).toHaveBeenCalledWith(tab.id);
    expect(heard).toHaveBeenCalled();
    expect(live.tabs(A)).toEqual([]);
  });
});
