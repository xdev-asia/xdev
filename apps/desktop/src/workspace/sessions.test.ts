import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import type { HookEvent, PtyInfo } from "@/api";
import { INTERRUPT_MS, STALE_MS } from "./status";
import { addTab, leaves, paneOf, removeTab, splitPane, toggleExpand } from "./paneTree";
import { CLOSED_KEPT, DONE_QUIET_MS, Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";

type Profile = string;

const CLAUDE: HookEvent[] = ["prompt", "needs-input", "resume", "turn-failed", "turn-done"];
// `true`: a claude past the version gate; a list: just those events.
const info = (id: string, hooks: boolean | HookEvent[]): PtyInfo => ({
  id,
  pid: 1,
  program: "agent",
  agent: true,
  profile: "claude",
  permissions: "ask",
  account: null,
  accountSource: null,
  hooks: hooks !== false,
  hookEvents: hooks === true ? CLAUDE : hooks === false ? [] : hooks,
  cli: "claude",
});

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

  it("restart_keeps_account", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude", "work");
    expect(tab.account).toBe("work");
    const next = live.restart(tab.id)!;
    expect(next).toMatchObject({ profileId: "claude", account: "work", agent: true });
    expect(next.id).not.toBe(tab.id);
  });

  it("dispose kills every tab it holds", async () => {
    const api = createMockApi({});
    const live = new Sessions(api);
    const a = await spawn(live, A, "shell");
    const b = await spawn(live, B, "shell");
    live.open(B, "shell");
    const kill = vi.spyOn(api, "ptyKill");
    live.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(kill.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(live.tabs(A)).toEqual([]);
    expect(live.tabs(B)).toEqual([]);
  });

  it("lists the worktrees that have tabs", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    live.open(A, "shell");
    live.open(A, "shell");
    live.open(B, "shell");
    expect(live.worktrees()).toEqual([A, B]);
  });

  it("removing_a_worktree_kills_its_sessions_first", async () => {
    const api = createMockApi({});
    await api.ptyApprove("claude", null);
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
    await spawn(live, A, "shell");
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

  it("does not wait for a tab whose pty never started", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const started = await spawn(live, A, "shell");
    const never = live.open(A, "claude");
    const kill = vi.spyOn(api, "ptyKill");
    let done = false;
    const closing = live.closeWorktree(A).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await closing;
    expect(kill.mock.calls.map((c) => c[0]).sort()).toEqual([started.id, never.id].sort());
    expect(live.tabs(A)).toEqual([]);
  });

  it("keeps the exit code, and start again replaces the tab with a new pty", async () => {
    const api = createMockApi({});
    let fire: (e: { id: string; code: number | null }) => void = () => {};
    vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => ((fire = cb), () => {}));
    const live = (sessions = new Sessions(api));
    const first = await spawn(live, A, "shell");
    const second = live.open(A, "codex");
    fire({ id: first.id, code: 1 });
    expect(live.tabs(A)[0]).toMatchObject({ status: "failed", exitCode: 1 });
    const kill = vi.spyOn(api, "ptyKill");

    const again = live.restart(first.id)!;
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ worktree: A, profileId: "shell", status: "idle" });
    expect(again.exitCode).toBeUndefined();
    // Same place in the strip.
    expect(live.tabs(A).map((t) => t.id)).toEqual([again.id, second.id]);
    await Promise.resolve();
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith(first.id);
    expect(live.restart("gone")).toBeNull();
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

  it("profilesOf lists distinct profiles in tab order", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    expect(live.profilesOf(A)).toEqual([]);
    live.open(A, "claude");
    live.open(A, "shell");
    live.open(A, "claude");
    live.open(A, "codex");
    live.open(B, "shell");
    expect(live.profilesOf(A)).toEqual(["claude", "shell", "codex"]);
    expect(live.profilesOf(B)).toEqual(["shell"]);
  });

  it("lastActivity is the latest output time", () => {
    let t = 1_000;
    const live = (sessions = new Sessions(createMockApi({}), () => t));
    const one = live.open(A, "claude");
    const two = live.open(A, "codex");
    // No output yet.
    expect(live.lastActivity(A)).toBeNull();
    t = 5_000;
    live.noteOutput(one.id, 10);
    t = 9_000;
    live.noteOutput(two.id, 10);
    t = 7_000;
    live.noteOutput(one.id, 10);
    // The latest of the tabs, not the last call.
    expect(live.lastActivity(A)).toBe(9_000);
    expect(live.lastActivity(B)).toBeNull();
    // An empty read is not activity.
    live.noteOutput(live.open(B, "claude").id, 0);
    expect(live.lastActivity(B)).toBeNull();
  });

  it("open adds to the focused pane and builds the layout", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    expect(live.layout(A)).toBeNull();
    const one = live.open(A, "shell");
    const two = live.open(A, "claude");
    const l = live.layout(A)!;
    expect(leaves(l).map((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([[one.id, two.id]]);
    expect(live.layout(A)).toBe(l);
    expect(live.layout(B)).toBeNull();
    // A new tab lands in the focused pane.
    live.setLayout(A, splitPane(l, l.focused, "right", live.open(A, "codex").id));
    const three = live.tabs(A)[2];
    expect(paneOf(live.layout(A)!, three.id)).toBe(live.layout(A)!.focused);
    const four = live.open(A, "shell");
    expect(paneOf(live.layout(A)!, four.id)).toBe(paneOf(live.layout(A)!, three.id));
  });

  it("setLayout tells listeners once and ignores the same value", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const one = live.open(A, "shell");
    const heard = vi.fn();
    live.subscribe(heard);
    live.setLayout(A, live.layout(A));
    expect(heard).not.toHaveBeenCalled();
    live.setLayout(A, addTab(live.layout(A)!, "review:"));
    expect(heard).toHaveBeenCalledTimes(1);
    live.setLayout(A, null);
    expect(live.layout(A)).toBeNull();
    expect(one.id).toBeTruthy();
  });

  it("closing and exiting a tab remove it from the layout; the last one clears it", async () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const one = live.open(A, "shell");
    const two = live.open(A, "claude");
    live.setLayout(A, splitPane(live.layout(A)!, live.layout(A)!.focused, "down", live.open(A, "codex").id));
    const three = live.tabs(A)[2];
    await live.close(three.id);
    expect(leaves(live.layout(A)!)).toHaveLength(1);
    await live.close(two.id);
    expect(paneOf(live.layout(A)!, one.id)).not.toBeNull();
    expect(paneOf(live.layout(A)!, two.id)).toBeNull();
    await live.close(one.id);
    expect(live.layout(A)).toBeNull();
  });

  it("restart keeps the position in the layout", async () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const one = live.open(A, "shell");
    const two = live.open(A, "claude");
    const three = live.open(A, "codex");
    let l = live.layout(A)!;
    l = splitPane(removeTab(l, three.id)!, l.focused, "right", three.id);
    live.setLayout(A, l);
    const again = live.restart(three.id)!;
    const after = live.layout(A)!;
    expect(paneOf(after, again.id)).toBe(paneOf(l, three.id));
    expect(paneOf(after, three.id)).toBeNull();
    expect(leaves(after).map((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([[one.id, two.id], [again.id]]);
  });

  it("visible is the active tab of each pane, or the expanded pane only", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const one = live.open(A, "shell");
    expect(live.visible(B)).toEqual([]);
    const two = live.open(A, "claude");
    const three = live.open(A, "codex");
    let l = live.layout(A)!;
    l = splitPane(removeTab(l, three.id)!, l.focused, "right", three.id);
    live.setLayout(A, l);
    expect(live.visible(A)).toEqual([two.id, three.id]);
    const first = paneOf(live.layout(A)!, one.id)!;
    live.setLayout(A, toggleExpand(live.layout(A)!, first));
    expect(live.visible(A)).toEqual([two.id]);
    // The review tab is not a terminal.
    live.setLayout(A, addTab(live.layout(A)!, "review:", first));
    expect(live.visible(A)).toEqual([]);
  });

  it("setSeen and unread work with two panes on screen", async () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const one = live.open(A, "claude");
    const two = live.open(A, "claude");
    live.setLayout(A, splitPane(removeTab(live.layout(A)!, two.id)!, live.layout(A)!.focused, "right", two.id));
    live.noteBell(one.id);
    live.noteBell(two.id);
    expect(live.tabs(A).every((t) => t.unread)).toBe(true);
    live.setSeen(live.visible(A));
    expect(live.tabs(A).some((t) => t.unread)).toBe(false);
    expect(live.unread(A)).toBe(false);
  });

  it("turn_done_on_seen_pane_is_idle_and_quiet", () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    live.onAttention(heard);
    live.setSeen([tab.id]);
    api.__hook(tab.id, "prompt");
    expect(live.tabs(A)[0].status).toBe("working");
    api.__hook(tab.id, "turn-done");
    expect(live.tabs(A)[0]).toMatchObject({ status: "idle", unread: false });
    expect(heard).not.toHaveBeenCalled();
    expect(live.unread(A)).toBe(false);
  });

  it("onStatus hears each status change of an agent tab, with the old and the new status", () => {
    let t = 100;
    const api = createMockApi({});
    const live = (sessions = new Sessions(api, () => t));
    const tab = live.open(A, "claude");
    const shell = live.open(A, "shell");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    const off = live.onStatus(heard);
    api.__hook(tab.id, "prompt");
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ id: tab.id, status: "working" }), "idle", "working", 100);
    t = 200;
    api.__hook(tab.id, "needs-input");
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ id: tab.id }), "working", "needs-you", 200);
    // The same status again is not a change.
    const calls = heard.mock.calls.length;
    api.__hook(tab.id, "needs-input");
    expect(heard).toHaveBeenCalledTimes(calls);
    // A plain shell is not an agent: nothing is heard for it.
    live.noteOutput(shell.id, 10);
    expect(heard.mock.calls.every(([x]) => x.id === tab.id)).toBe(true);
    off();
    api.__hook(tab.id, "resume");
    expect(heard).toHaveBeenCalledTimes(calls);
  });

  it("onStatus hears the exit of an agent tab", async () => {
    const api = createMockApi({});
    let fire: (e: { id: string; code: number | null }) => void = () => {};
    vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => ((fire = cb), () => {}));
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude");
    await Promise.resolve();
    const heard = vi.fn();
    live.onStatus(heard);
    fire({ id: tab.id, code: 0 });
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id }), "idle", expect.stringMatching(/^(exited|failed)$/), expect.any(Number));
  });

  it("turn_done_on_hidden_pane_is_unread", () => {
    vi.useFakeTimers();
    let t = 42;
    const api = createMockApi({});
    const live = (sessions = new Sessions(api, () => t));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    live.onAttention(heard);
    api.__hook(tab.id, "prompt");
    api.__hook(tab.id, "turn-done");
    // Done, but news only once it stays done.
    expect(live.tabs(A)[0]).toMatchObject({ status: "done", unread: false });
    t += DONE_QUIET_MS - 1;
    vi.advanceTimersByTime(DONE_QUIET_MS - 1);
    expect(heard).not.toHaveBeenCalled();
    t += 1;
    vi.advanceTimersByTime(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(live.tabs(A)[0]).toMatchObject({ status: "done", unread: true, unreadAt: 42 + DONE_QUIET_MS });
    expect(live.unread(A)).toBe(true);
    expect(live.unreadTabs().map((t) => t.id)).toEqual([tab.id]);
    expect(live.dot(A)).toBe("done");
    // Looking at it clears it and the finished turn rests.
    live.setSeen([tab.id]);
    expect(live.tabs(A)[0]).toMatchObject({ status: "idle", unread: false, unreadAt: null });
    expect(live.unreadTabs()).toEqual([]);
  });

  it("one_transition_notifies_once", () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    const off = live.onAttention(heard);
    api.__hook(tab.id, "needs-input");
    api.__hook(tab.id, "needs-input");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toMatchObject({ id: tab.id, status: "needs-you" });
    expect(heard.mock.calls[0][1]).toBe("needs-you");
    api.__hook(tab.id, "turn-done");
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard.mock.calls[1][1]).toBe("done");
    off();
    api.__hook(tab.id, "needs-input");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("shells and closing worktrees ask for no one", async () => {
    const api = createMockApi({});
    await api.ptyApprove("claude", null);
    let fire: (e: { id: string; code: number | null }) => void = () => {};
    const realExit = api.onPtyExit.bind(api);
    vi.spyOn(api, "onPtyExit").mockImplementation(async (cb) => {
      fire = cb;
      return realExit(cb);
    });
    const live = (sessions = new Sessions(api));
    const heard = vi.fn();
    live.onAttention(heard);
    const shell = live.open(B, "shell");
    fire({ id: shell.id, code: 1 });
    expect(live.tabs(B)[0]).toMatchObject({ status: "failed", unread: false });
    const agent = await spawn(live, A, "claude");
    await live.closeWorktree(A);
    expect(live.tabs(A)).toEqual([]);
    expect(heard).not.toHaveBeenCalled();
    // An agent that fails on its own does ask.
    const other = live.open(B, "codex");
    fire({ id: other.id, code: 2 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][1]).toBe("failed");
    expect(agent.id).not.toBe(other.id);
  });

  it("mark unread sticks until a pane is seen", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const one = live.open(A, "claude");
    const two = live.open(B, "claude");
    live.setSeen([one.id]);
    const heard = vi.fn();
    live.subscribe(heard);
    live.markUnread(A);
    expect(live.unread(A)).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    // Still looking at the same pane does not clear it.
    live.setSeen([one.id]);
    expect(live.unread(A)).toBe(true);
    // Another worktree's pane does not either.
    live.setSeen([two.id]);
    expect(live.unread(A)).toBe(true);
    live.setSeen([one.id]);
    expect(live.unread(A)).toBe(false);
  });

  it("a title sets the name unless renamed", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.open(A, "claude");
    live.noteTitle(tab.id, "  fixing the parser  ");
    expect(live.tabs(A)[0].title).toBe("fixing the parser");
    const before = live.tabs(A);
    live.noteTitle(tab.id, "fixing the parser");
    expect(live.tabs(A)).toBe(before);
    live.noteTitle(tab.id, "x".repeat(500));
    expect(live.tabs(A)[0].title).toHaveLength(200);
    live.rename(tab.id, "Parser");
    live.noteTitle(tab.id, "something else");
    expect(live.tabs(A)[0]).toMatchObject({ title: "Parser", renamed: true });
    // A blank title clears an unnamed tab's title.
    const other = live.open(A, "codex");
    live.noteTitle(other.id, "busy");
    live.noteTitle(other.id, "   ");
    expect(live.tabs(A)[1].title).toBeNull();
  });

  it("an auto title beats the program title and loses to a name by hand", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.open(A, "claude");
    live.noteTitle(tab.id, "program says");
    live.setAutoTitle(tab.id, "  Fix the parser  ");
    expect(live.tabs(A)[0]).toMatchObject({ title: "Fix the parser", autoTitled: true, renamed: false });
    // The program's later titles are kept but do not show.
    live.noteTitle(tab.id, "program again");
    expect(live.tabs(A)[0].title).toBe("Fix the parser");
    // Same title again: same array.
    const before = live.tabs(A);
    live.setAutoTitle(tab.id, "Fix the parser");
    expect(live.tabs(A)).toBe(before);
    // A name by hand wins; the auto title can no longer replace it.
    live.rename(tab.id, "Mine");
    live.setAutoTitle(tab.id, "Other");
    expect(live.tabs(A)[0]).toMatchObject({ title: "Mine", renamed: true, autoTitled: false });
    // Giving the name back returns the auto title, then a blank auto title is ignored.
    live.setTitle(tab.id, null);
    expect(live.tabs(A)[0]).toMatchObject({ title: "Fix the parser", autoTitled: true, renamed: false });
    live.setAutoTitle(tab.id, "   ");
    expect(live.tabs(A)[0].title).toBe("Fix the parser");
  });

  it("without an auto title, giving a name back returns the program title", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.open(A, "claude");
    live.noteTitle(tab.id, "program says");
    live.rename(tab.id, "Mine");
    live.setTitle(tab.id, null);
    expect(live.tabs(A)[0]).toMatchObject({ title: "program says", autoTitled: false });
    live.setAutoTitle("no-such-tab", "x");
  });

  it("an auto title is saved in the layout and comes back on restore", async () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.open(A, "claude");
    live.setAutoTitle(tab.id, "Fix the parser");
    const snap = live.snapshot().worktrees[A]!;
    const saved = Object.values(snap.tabs)[0]!;
    expect(saved).toMatchObject({ title: "Fix the parser", autoTitled: true });
    live.rename(tab.id, "Mine");
    expect(Object.values(live.snapshot().worktrees[A]!.tabs)[0]).toMatchObject({ title: "Mine", renamed: true });
    expect(Object.values(live.snapshot().worktrees[A]!.tabs)[0]).not.toHaveProperty("autoTitled");
  });

  it("hook caps come from the pty, and a turn-done tab needs no tick", () => {
    vi.useFakeTimers();
    let t = 10_000;
    const api = createMockApi({});
    const live = (sessions = new Sessions(api, () => t));
    const tab = live.open(A, "codex");
    // codex on its private home: the prompt starts the turn, the hook ends it.
    live.noteStarted(tab.id, info(tab.id, ["prompt", "needs-input", "resume", "turn-done", "interrupt"]));
    live.noteOutput(tab.id, 5);
    expect(live.tabs(A)[0].status).toBe("idle");
    api.__hook(tab.id, "prompt");
    expect(live.tabs(A)[0].status).toBe("working");
    // Quiet does not end a hooked turn: only the 30 minute stale timer waits.
    expect(vi.getTimerCount()).toBe(1);
    t += 5000;
    vi.advanceTimersByTime(5000);
    expect(live.tabs(A)[0].status).toBe("working");
    api.__hook(tab.id, "turn-done");
    expect(live.tabs(A)[0].status).toBe("done");
    t += DONE_QUIET_MS;
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(vi.getTimerCount()).toBe(0);
    // codex on notify alone: timing woke it, so quiet ends it; the hook still says done.
    const notify = live.open(A, "codex");
    live.noteStarted(notify.id, info(notify.id, ["turn-done"]));
    live.noteOutput(notify.id, 5);
    expect(live.tabs(A)[1].status).toBe("working");
    t += 3000;
    vi.advanceTimersByTime(3000);
    expect(live.tabs(A)[1].status).toBe("idle");
    api.__hook(notify.id, "turn-done");
    expect(live.tabs(A)[1].status).toBe("done");
    t += DONE_QUIET_MS;
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(vi.getTimerCount()).toBe(0);
    // Without hooks, the same profile goes back to timing.
    const plain = live.open(A, "codex");
    live.noteStarted(plain.id, info(plain.id, false));
    live.noteOutput(plain.id, 5);
    expect(vi.getTimerCount()).toBe(1);
    t += 3000;
    vi.advanceTimersByTime(3000);
    expect(live.tabs(A)[2].status).toBe("idle");
  });

  it("a done that goes back to work or is looked at is never announced", () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    live.onAttention(heard);
    api.__hook(tab.id, "turn-done");
    vi.advanceTimersByTime(500);
    api.__hook(tab.id, "prompt");
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(heard).not.toHaveBeenCalled();
    api.__hook(tab.id, "turn-done");
    live.setSeen([tab.id]);
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(heard).not.toHaveBeenCalled();
    expect(live.tabs(A)[0]).toMatchObject({ status: "idle", unread: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hooks switched off send open panes back to timing, and on restores their caps", () => {
    vi.useFakeTimers();
    let t = 1_000;
    const api = createMockApi({});
    const live = (sessions = new Sessions(api, () => t));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    api.__hook(tab.id, "prompt");
    expect(live.tabs(A)[0].status).toBe("working");
    // The marker now drops every hook: quiet has to end the turn, not a 30 minute wait.
    live.setHooks(false);
    t += 3000;
    vi.advanceTimersByTime(3000);
    expect(live.tabs(A)[0].status).toBe("idle");
    // A pane started while off keeps no caps.
    const later = live.open(A, "claude");
    live.noteStarted(later.id, info(later.id, true));
    live.noteOutput(later.id, 5);
    expect(live.tabs(A)[1].status).toBe("working");
    t += 3000;
    vi.advanceTimersByTime(3000);
    expect(live.tabs(A)[1].status).toBe("idle");
    live.setHooks(true);
    live.noteOutput(tab.id, 5);
    expect(live.tabs(A)[0].status).toBe("idle");
    api.__hook(tab.id, "prompt");
    t += 5000;
    vi.advanceTimersByTime(5000);
    expect(live.tabs(A)[0].status).toBe("working");
  });

  it("a tab opened without a cli takes the one its pty reports", () => {
    const live = (sessions = new Sessions(createMockApi({})));
    const tab = live.open(A, "work", null);
    expect(live.tabs(A)[0].cli).toBeNull();
    live.noteStarted(tab.id, { ...info(tab.id, true), profile: "work", cli: "codex" });
    expect(live.tabs(A)[0].cli).toBe("codex");
    // gemini has no title rules or caps of its own here: it stays null.
    const g = live.open(A, "gem", null);
    live.noteStarted(g.id, { ...info(g.id, false), profile: "gem", cli: "gemini" });
    expect(live.tabs(A)[1].cli).toBeNull();
  });

  it("a resume inside the done window keeps the turn going and is not announced (R18)", () => {
    vi.useFakeTimers();
    let t = 1_000;
    const api = createMockApi({});
    const live = (sessions = new Sessions(api, () => t));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    live.onAttention(heard);
    api.__hook(tab.id, "prompt");
    api.__hook(tab.id, "turn-done");
    t += 500;
    vi.advanceTimersByTime(500);
    api.__hook(tab.id, "resume");
    expect(live.tabs(A)[0].status).toBe("working");
    t += DONE_QUIET_MS;
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(heard).not.toHaveBeenCalled();
    // After the window, a done is settled: a stray resume no longer reopens it.
    api.__hook(tab.id, "turn-done");
    t += DONE_QUIET_MS;
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(heard).toHaveBeenCalledTimes(1);
    api.__hook(tab.id, "resume");
    expect(live.tabs(A)[0].status).toBe("done");
  });

  it("escape on a hooked working pane settles idle after 500 ms and asks no one", () => {
    vi.useFakeTimers();
    let t = 1_000;
    const api = createMockApi({});
    const live = (sessions = new Sessions(api, () => t));
    const tab = live.open(A, "claude");
    live.noteStarted(tab.id, info(tab.id, true));
    const heard = vi.fn();
    live.onAttention(heard);
    api.__hook(tab.id, "prompt");
    live.noteInput(tab.id, "");
    t += INTERRUPT_MS - 1;
    vi.advanceTimersByTime(INTERRUPT_MS - 1);
    expect(live.tabs(A)[0].status).toBe("working");
    t += 1;
    vi.advanceTimersByTime(1);
    expect(live.tabs(A)[0]).toMatchObject({ status: "idle", unread: false });
    // Ctrl-C followed at once by the turn end rests too.
    api.__hook(tab.id, "prompt");
    live.noteInput(tab.id, "");
    t += 100;
    api.__hook(tab.id, "turn-done");
    vi.advanceTimersByTime(DONE_QUIET_MS);
    expect(live.tabs(A)[0].status).toBe("idle");
    expect(heard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("plan 4b", () => {
    const ESC = String.fromCharCode(27);
    const ctrlC = String.fromCharCode(3);

    function agent(now: () => number = () => 1_000, suppress = () => true, profile = "claude") {
      vi.useFakeTimers();
      const api = createMockApi({});
      const live = (sessions = new Sessions(api, now, suppress));
      const tab = live.open(A, profile);
      live.noteStarted(tab.id, info(tab.id, true));
      const heard = vi.fn();
      live.onAttention(heard);
      return { api, live, tab, heard };
    }

    it("escape on a needs-you pane settles idle after 500 ms, quietly", () => {
      let t = 1_000;
      const { api, live, tab, heard } = agent(() => t);
      api.__hook(tab.id, "needs-input");
      expect(heard).toHaveBeenCalledTimes(1);
      live.noteInput(tab.id, ESC);
      t += INTERRUPT_MS;
      vi.advanceTimersByTime(INTERRUPT_MS);
      expect(live.tabs(A)[0].status).toBe("idle");
      expect(heard).toHaveBeenCalledTimes(1);
      live.noteInput(tab.id, ctrlC);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("an interrupt hook settles at once without a notice", () => {
      const { api, live, tab, heard } = agent(() => 1_000, undefined, "codex");
      api.__hook(tab.id, "prompt");
      api.__hook(tab.id, "interrupt");
      expect(live.tabs(A)[0]).toMatchObject({ status: "idle", unread: false });
      vi.advanceTimersByTime(DONE_QUIET_MS);
      expect(heard).not.toHaveBeenCalled();
      // A turn end that says it was an interrupt is no news either.
      api.__hook(tab.id, "prompt");
      api.__hook(tab.id, "turn-done", { toolName: null, message: null, isInterrupt: true, error: null });
      vi.advanceTimersByTime(DONE_QUIET_MS);
      expect(live.tabs(A)[0].status).toBe("idle");
      expect(heard).not.toHaveBeenCalled();
    });

    it("hook detail reaches the listener; resume works after needs-input", () => {
      const { api, live, tab, heard } = agent();
      const detail = { toolName: "Bash", message: "Run rm?", isInterrupt: false, error: null };
      api.__hook(tab.id, "needs-input", detail);
      expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ id: tab.id }), "needs-you", detail);
      expect(live.tabs(A)[0]).toMatchObject({ unread: true, unreadReason: "needs-you" });
      api.__hook(tab.id, "resume");
      expect(live.tabs(A)[0].status).toBe("working");
      api.__hook(tab.id, "attention", { toolName: null, message: "Come back", isInterrupt: false, error: null });
      expect(heard).toHaveBeenLastCalledWith(expect.anything(), "needs-you", expect.objectContaining({ message: "Come back" }));
    });

    it("turn-failed notifies as failed and the pane lives on", () => {
      const { api, live, tab, heard } = agent();
      const detail = { toolName: null, message: null, isInterrupt: false, error: "rate limit" };
      api.__hook(tab.id, "prompt");
      api.__hook(tab.id, "turn-failed", detail);
      expect(heard).toHaveBeenLastCalledWith(expect.anything(), "failed", detail);
      expect(live.tabs(A)[0]).toMatchObject({ status: "failed", unreadReason: "failed" });
      expect(live.tabs(A)[0].exitCode).toBeUndefined();
      api.__hook(tab.id, "prompt");
      expect(live.tabs(A)[0].status).toBe("working");
    });

    it("a bell on an unseen pane is unread with the reason bell; a seen pane is quiet", () => {
      const { live, tab, heard } = agent();
      live.setSeen([tab.id]);
      live.noteBell(tab.id);
      expect(heard).not.toHaveBeenCalled();
      expect(live.unread(A)).toBe(false);
      live.setSeen([]);
      live.noteBell(tab.id);
      expect(heard).toHaveBeenCalledWith(expect.anything(), "bell", null);
      expect(live.tabs(A)[0]).toMatchObject({ unread: true, unreadReason: "bell", status: "idle" });
    });

    it("a bell keeps an earlier reason", () => {
      const { api, live, tab } = agent();
      api.__hook(tab.id, "needs-input");
      live.noteBell(tab.id);
      expect(live.tabs(A)[0].unreadReason).toBe("needs-you");
    });

    it("suppressWhenFocused off: a seen pane notifies but is never unread", () => {
      let on = false;
      const { api, live, tab, heard } = agent(() => 1_000, () => on);
      live.setSeen([tab.id]);
      api.__hook(tab.id, "needs-input");
      expect(heard).toHaveBeenCalledTimes(1);
      expect(live.tabs(A)[0]).toMatchObject({ unread: false, status: "needs-you" });
      api.__hook(tab.id, "resume");
      api.__hook(tab.id, "turn-done");
      // done on a seen pane rests as idle at once, yet is told after the quiet period.
      expect(live.tabs(A)[0].status).toBe("idle");
      vi.advanceTimersByTime(DONE_QUIET_MS);
      expect(heard).toHaveBeenLastCalledWith(expect.anything(), "done", null);
      expect(live.tabs(A)[0].unread).toBe(false);
      live.noteBell(tab.id);
      expect(heard).toHaveBeenLastCalledWith(expect.anything(), "bell", null);
      expect(live.unread(A)).toBe(false);
      // With it on, none of that is told.
      on = true;
      heard.mockClear();
      api.__hook(tab.id, "prompt");
      api.__hook(tab.id, "turn-done");
      vi.advanceTimersByTime(DONE_QUIET_MS);
      live.noteBell(tab.id);
      expect(heard).not.toHaveBeenCalled();
    });

    it("working with no hook for 30 minutes goes idle and nobody is told", () => {
      let t = 1_000;
      const { api, live, tab, heard } = agent(() => t);
      api.__hook(tab.id, "prompt");
      t += STALE_MS - 1;
      vi.advanceTimersByTime(STALE_MS - 1);
      expect(live.tabs(A)[0].status).toBe("working");
      // A hook restarts the clock.
      api.__hook(tab.id, "resume");
      t += STALE_MS - 1;
      vi.advanceTimersByTime(STALE_MS - 1);
      expect(live.tabs(A)[0].status).toBe("working");
      t += 1;
      vi.advanceTimersByTime(1);
      expect(live.tabs(A)[0]).toMatchObject({ status: "idle", unread: false });
      expect(heard).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("markRead clears a worktree's hand mark and its unread tabs; unreadWorktrees counts worktrees", () => {
      const { api, live, tab } = agent();
      const other = live.open(B, "claude");
      api.__hook(tab.id, "needs-input");
      live.markUnread(B);
      expect(live.unreadWorktrees().sort()).toEqual([A, B].sort());
      expect(live.unreadWorktrees((x) => x.unreadReason === "done")).toEqual([B]);
      live.markRead(A);
      live.markRead(B);
      expect(live.unreadWorktrees()).toEqual([]);
      expect(live.tabs(A)[0]).toMatchObject({ unread: false, unreadReason: null });
      expect(other.unread).toBe(false);
    });
  });

  it("reopenClosed gives back the most recent tab closed in that worktree, and pops it", async () => {
    sessions = new Sessions(createMockApi({}));
    const shell = sessions.open(A, "shell");
    const agent = sessions.open(A, "claude", "acct");
    const other = sessions.open(B, "shell");
    await sessions.close(shell.id);
    await sessions.close(agent.id);
    await sessions.close(other.id);
    const first = sessions.reopenClosed(A)!;
    expect([first.profileId, first.account, first.worktree]).toEqual(["claude", "acct", A]);
    expect(first.id).not.toBe(agent.id);
    const second = sessions.reopenClosed(A)!;
    expect(second.profileId).toBe("shell");
    expect(sessions.reopenClosed(A)).toBeNull();
    expect(sessions.tabs(A).map((t) => t.id)).toEqual([first.id, second.id]);
    expect(sessions.reopenClosed(B)!.profileId).toBe("shell");
  });

  it("closing a whole worktree leaves nothing to reopen, and only the last ten are kept", async () => {
    sessions = new Sessions(createMockApi({}));
    sessions.open(A, "shell");
    await sessions.closeWorktree(A);
    expect(sessions.reopenClosed(A)).toBeNull();
    for (let i = 0; i < CLOSED_KEPT + 3; i++) await sessions.close(sessions.open(A, "shell").id);
    let back = 0;
    while (sessions.reopenClosed(A)) back++;
    expect(back).toBe(CLOSED_KEPT);
  });
});
