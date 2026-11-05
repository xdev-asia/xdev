import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { leaves } from "./paneTree";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";
const none = async () => null;

describe("Sessions sleep", () => {
  let s: Sessions | null = null;
  afterEach(() => {
    s?.dispose();
    s = null;
  });
  const make = (api = createMockApi({})) => (s = new Sessions(api));
  const agent = (live: Sessions, wt = A, session = "sess-1") => live.resume(wt, "claude", null, session, "Fix the parser");
  const slots = (live: Sessions, wt = A) => leaves(live.layout(wt)!).flatMap((n) => (n.kind === "leaf" ? n.tabs : []));

  it("hibernate kills the pty and keeps the slot, with a new id, asleep and the session to resume", async () => {
    const api = createMockApi({});
    const live = make(api);
    await api.ptyApprove("claude", null);
    const kill = vi.spyOn(api, "ptyKill");
    const spawn = vi.spyOn(api, "ptySpawn");
    const tab = agent(live);
    await tab.client.start(A, "claude", 80, 24, () => {});
    const before = spawn.mock.calls.length;
    const next = (await live.hibernate(tab.id, none))!;
    expect(next.id).not.toBe(tab.id);
    expect(next).toMatchObject({ asleep: true, resumeOf: "sess-1", agentSession: "sess-1", title: "Fix the parser", worktree: A });
    expect(kill).toHaveBeenCalledWith(tab.id);
    expect(spawn.mock.calls.length).toBe(before);
    expect(live.tab(tab.id)).toBeNull();
    expect(slots(live)).toEqual([next.id]);
  });

  it("a sleeping tab is never started", async () => {
    const api = createMockApi({});
    const live = make(api);
    const spawn = vi.spyOn(api, "ptySpawn");
    const next = (await live.hibernate(agent(live).id, none))!;
    expect(next.client.spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the pin and colour of the slot", async () => {
    const live = make();
    const tab = agent(live);
    live.setPinned(tab.id, true);
    live.setColor(tab.id, "c3");
    const next = (await live.hibernate(tab.id, none))!;
    expect(next).toMatchObject({ pinned: true, color: "c3" });
  });

  it("an agent with no session id asks the fallback; none found, it wakes as a new session", async () => {
    const live = make();
    const tab = live.open(A, "claude");
    const fallback = vi.fn(async () => "found-1");
    const next = (await live.hibernate(tab.id, fallback))!;
    expect(fallback).toHaveBeenCalledWith(A, "claude", tab.openedAt);
    expect(next.agentSession).toBe("found-1");
    const lost = live.open(B, "claude");
    expect((await live.hibernate(lost.id, none))!.agentSession).toBeNull();
  });

  it("a shell tab sleeps too and wakes as a new shell", async () => {
    const live = make();
    const tab = live.open(A, "shell");
    const next = (await live.hibernate(tab.id, none))!;
    expect(next.asleep).toBe(true);
    const woke = live.wake(next.id)!;
    expect(woke.asleep).toBeUndefined();
    expect(woke).toMatchObject({ profileId: "shell", resumeOf: null });
  });

  it("wake resumes the agent session in the same slot and leaves it for the view to start", async () => {
    const api = createMockApi({});
    const live = make(api);
    const spawn = vi.spyOn(api, "ptySpawn");
    const asleep = (await live.hibernate(agent(live).id, none))!;
    const woke = live.wake(asleep.id)!;
    expect(woke).toMatchObject({ resumeOf: "sess-1", agentSession: "sess-1", title: "Fix the parser" });
    expect(woke.asleep).toBeUndefined();
    expect(woke.id).not.toBe(asleep.id);
    expect(slots(live)).toEqual([woke.id]);
    expect(live.deferred(woke.id)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(live.wake("gone")).toBeNull();
    expect(live.wake(woke.id)).toBe(woke);
  });

  it("the exit of the old pty does not touch the sleeping tab", async () => {
    const api = createMockApi({});
    let exit: (e: { id: string; code: number | null }) => void = () => {};
    vi.spyOn(api, "onPtyExit").mockImplementation((l) => {
      exit = l;
      return Promise.resolve(() => {});
    });
    const live = make(api);
    const tab = agent(live);
    const next = (await live.hibernate(tab.id, none))!;
    exit({ id: tab.id, code: 0 });
    expect(live.tab(next.id)?.exitCode).toBeUndefined();
    expect(live.tab(next.id)?.status).toBe("idle");
  });

  it("sleepWorktree without children leaves the child tabs awake", async () => {
    const live = make();
    agent(live, A, "a-1");
    agent(live, B, "b-1");
    await live.sleepWorktree(A, none);
    expect(live.asleep(A)).toBe(true);
    expect(live.tabs(B).some((t) => t.asleep)).toBe(false);
  });

  it("sleepWorktree sleeps every tab, children on request; wakeWorktree wakes them", async () => {
    const live = make();
    agent(live, A, "a-1");
    live.open(A, "shell");
    agent(live, B, "b-1");
    expect(live.asleep(A)).toBe(false);
    await live.sleepWorktree(A, none);
    expect(live.asleep(A)).toBe(true);
    expect(live.asleep(B)).toBe(false);
    expect(live.tabs(A).every((t) => t.asleep)).toBe(true);
    await live.sleepWorktree(A, none, [B]);
    expect(live.asleep(B)).toBe(true);
    expect(live.wakeWorktree(A)).toHaveLength(2);
    expect(live.asleep(A)).toBe(false);
    expect(live.asleep(B)).toBe(true);
    expect(live.asleep("/none")).toBe(false);
  });

  it("closing a sleeping tab works like closing any tab", async () => {
    const live = make();
    const next = (await live.hibernate(agent(live).id, none))!;
    await live.close(next.id);
    expect(live.tabs(A)).toEqual([]);
  });

  it("never puts a working agent to sleep, also when it starts working during the lookup", async () => {
    const live = (s = new Sessions(createMockApi({}), () => 1_000));
    const busy = agent(live, A, "busy-1");
    const resting = agent(live, A, "rest-1");
    live.noteOutput(busy.id, 10);
    expect(live.tab(busy.id)?.status).toBe("working");
    expect(await live.hibernate(busy.id, none)).toBeNull();
    await live.sleepWorktree(A, none);
    expect(live.tab(busy.id)?.asleep).toBeUndefined();
    expect(live.tabs(A).filter((t) => t.asleep).map((t) => t.agentSession)).toEqual(["rest-1"]);
    expect(live.tab(resting.id)).toBeNull();
    // Status changes while the fallback runs.
    const late = live.open(B, "claude");
    const next = await live.hibernate(late.id, async () => {
      live.noteOutput(late.id, 10);
      return "found-2";
    });
    expect(next).toBeNull();
    expect(live.tab(late.id)?.asleep).toBeUndefined();
  });
});
