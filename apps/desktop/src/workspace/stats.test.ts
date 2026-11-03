import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { Sessions } from "./sessions";
import { WorktreeStats, type FocusTarget } from "./stats";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";

function focusTarget() {
  const listeners = new Set<() => void>();
  const target: FocusTarget = {
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  };
  return { target, focus: () => listeners.forEach((l) => l()), count: () => listeners.size };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("WorktreeStats", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    vi.useRealTimers();
  });

  it("reads the listed worktrees once attached, and a new one when it is listed", async () => {
    const api = createMockApi({});
    const read = vi.spyOn(api, "worktreeStat");
    const stats = new WorktreeStats();
    // Listed before the store is attached: read on attach.
    stats.track([A]);
    expect(read).not.toHaveBeenCalled();
    stats.attach(api, (sessions = new Sessions(api)));
    await settle();
    expect(read.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(stats.all()[A]).toEqual({ files: 3, added: 4, removed: 3 });

    stats.track([A, B]);
    await settle();
    expect(read.mock.calls.map((c) => c[0])).toEqual([A, B]);
    expect(stats.all()[B]).toEqual({ files: 0, added: 0, removed: 0 });

    // A worktree that is no longer listed loses its count.
    stats.track([B]);
    expect(Object.keys(stats.all())).toEqual([B]);
    stats.detach();
  });

  it("reads again when a worktree settles to idle, and not while it works", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const read = vi.spyOn(api, "worktreeStat");
    let t = 10_000;
    const live = (sessions = new Sessions(api, () => t));
    const stats = new WorktreeStats();
    stats.attach(api, live);
    stats.track([A]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    // A first agent tab starts idle: the dot appears.
    const tab = live.open(A, "claude");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);

    t += 1000;
    live.noteOutput(tab.id, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.dot(A)).toBe("working");
    expect(read).toHaveBeenCalledTimes(2);

    // Quiet for 3 s: idle again, so the count is read.
    t += 3000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(live.dot(A)).toBe("idle");
    expect(read).toHaveBeenCalledTimes(3);

    // No timer reads it afterwards.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
    stats.detach();
  });

  it("reads again when a hooked turn ends as done", async () => {
    const api = createMockApi({});
    const read = vi.spyOn(api, "worktreeStat");
    const live = (sessions = new Sessions(api));
    const stats = new WorktreeStats();
    stats.attach(api, live);
    stats.track([A]);
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, { id: tab.id, pid: 1, program: "agent", agent: true, profile: "claude", permissions: "ask", account: null, hooks: true, hookEvents: ["prompt", "turn-done"], cli: "claude" });
    api.__hook(tab.id, "prompt");
    await settle();
    const before = read.mock.calls.length;
    api.__hook(tab.id, "turn-done");
    await settle();
    expect(live.dot(A)).toBe("done");
    expect(read.mock.calls.length).toBe(before + 1);
    stats.detach();
  });

  it("reads every listed worktree on focus, redraws, and stops after detach", async () => {
    const api = createMockApi({});
    const read = vi.spyOn(api, "worktreeStat");
    const focus = focusTarget();
    const stats = new WorktreeStats();
    const redraw = vi.fn();
    stats.subscribe(redraw);
    stats.attach(api, (sessions = new Sessions(api)), focus.target);
    stats.track([A, B]);
    await settle();
    read.mockClear();
    redraw.mockClear();
    const before = stats.snapshot();

    focus.focus();
    // The redraw comes first, before any read has returned.
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(stats.snapshot()).toBeGreaterThan(before);
    await settle();
    expect(read.mock.calls.map((c) => c[0])).toEqual([A, B]);
    // Same counts: nothing else redraws.
    expect(redraw).toHaveBeenCalledTimes(1);

    stats.detach();
    expect(focus.count()).toBe(0);
    focus.focus();
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a focus within 30 s of the last focus read redraws but reads nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const api = createMockApi({});
    const read = vi.spyOn(api, "worktreeStat");
    const focus = focusTarget();
    const stats = new WorktreeStats();
    stats.attach(api, (sessions = new Sessions(api)), focus.target);
    stats.track([A, B]);
    await settle();
    focus.focus();
    await settle();
    read.mockClear();

    vi.setSystemTime(1_000_000 + 29_000);
    const before = stats.snapshot();
    focus.focus();
    await settle();
    expect(stats.snapshot()).toBeGreaterThan(before);
    expect(read).not.toHaveBeenCalled();

    vi.setSystemTime(1_000_000 + 30_000);
    focus.focus();
    await settle();
    expect(read.mock.calls.map((c) => c[0])).toEqual([A, B]);
    stats.detach();
  });

  it("keeps the last count when a read fails", async () => {
    const api = createMockApi({});
    const stats = new WorktreeStats();
    stats.attach(api, (sessions = new Sessions(api)));
    stats.track([A]);
    await settle();
    const first = stats.all()[A];
    vi.spyOn(api, "worktreeStat").mockRejectedValue({ code: "io" });
    const focus = focusTarget();
    stats.attach(api, sessions, focus.target);
    focus.focus();
    await settle();
    expect(stats.all()[A]).toEqual(first);
    stats.detach();
  });
});
