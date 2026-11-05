import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { LAYOUT_VERSION, restoredAccount, type LayoutSnapshot, type TabSnapshot } from "./layoutSnapshot";
import { leaves } from "./paneTree";
import { translate } from "@/i18n";
import { takePrime } from "@/terminal/restorePrime";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";
const GONE = "/demo/wt/gone";

const claude = (over: Partial<Extract<TabSnapshot, { kind: "terminal" }>> = {}): TabSnapshot => ({
  kind: "terminal", profileId: "claude", account: null, cli: "claude", title: null, renamed: false, pinned: false,
  color: "none", agent: true, agentSession: null, openedAt: 500, ...over,
});
const shell = (over: Partial<Extract<TabSnapshot, { kind: "terminal" }>> = {}): TabSnapshot =>
  claude({ profileId: "shell", cli: null, agent: false, ...over });

// One pane holding t1 and t2.
const one = (tabs: Record<string, TabSnapshot>) => ({
  layout: { root: { kind: "leaf" as const, id: "p1", tabs: Object.keys(tabs), active: Object.keys(tabs)[0] }, focused: "p1", expanded: null },
  tabs,
});
const snap = (worktrees: LayoutSnapshot["worktrees"]): LayoutSnapshot => ({ version: LAYOUT_VERSION, savedAt: 1, worktrees });
const never = vi.fn(async () => null);

describe("Sessions.restore", () => {
  let sessions: Sessions | null = null;
  const make = () => (sessions = new Sessions(createMockApi({})));
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    never.mockClear();
  });

  it("resumes an agent tab with its own session id and puts the tab's fields back", async () => {
    const s = make();
    const resume = vi.spyOn(s, "resume");
    const report = await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "abc", title: "Fix it", renamed: true, pinned: true, color: "c2", account: "work" }) }) }), "all", never);
    expect(resume).toHaveBeenCalledWith(A, "claude", "work", "abc", "Fix it", "claude");
    expect(never).not.toHaveBeenCalled();
    expect(report).toMatchObject({ resumed: 1, fresh: 0, skipped: [] });
    expect(s.tabs(A)[0]).toMatchObject({ agentSession: "abc", title: "Fix it", renamed: true, pinned: true, color: "c2" });
    expect(report.opened).toEqual([s.tabs(A)[0].id]);
  });

  it("asks the fallback for an agent without an id and resumes what it finds", async () => {
    const s = make();
    const fallback = vi.fn(async () => "x");
    const report = await s.restore(snap({ [A]: one({ t1: claude() }) }), "all", fallback);
    expect(fallback).toHaveBeenCalledWith(A, "claude", 500);
    expect(s.tabs(A)[0].resumeOf).toBe("x");
    expect(report).toMatchObject({ resumed: 1, fresh: 0 });
  });

  it("opens a fresh agent when the fallback finds nothing and the mode is all", async () => {
    const s = make();
    const open = vi.spyOn(s, "open");
    const report = await s.restore(snap({ [A]: one({ t1: claude() }) }), "all", never);
    expect(open).toHaveBeenCalledWith(A, "claude", null, "claude");
    expect(report).toMatchObject({ resumed: 0, fresh: 1 });
  });

  it("agentsOnly skips shells and agents with no session", async () => {
    const s = make();
    const report = await s.restore(snap({ [A]: one({ t1: shell(), t2: claude(), t3: claude({ agentSession: "k" }) }) }), "agentsOnly", never);
    expect(s.tabs(A).map((t) => t.profileId)).toEqual(["claude"]);
    expect(report).toMatchObject({ resumed: 1, fresh: 0, skipped: [{ worktree: A, reason: "noSession" }] });
    expect(leaves(s.layout(A)!).flatMap((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([s.tabs(A)[0].id]);
  });

  it("none does nothing, and a second restore does nothing", async () => {
    const s = make();
    const s1 = snap({ [A]: one({ t1: shell(), "file:a.ts": { kind: "file", rel: "a.ts" }, "review:": { kind: "review" } }) });
    const openFile = vi.fn(async () => true);
    expect(await s.restore(s1, "none", never, { openFile })).toEqual({ resumed: 0, fresh: 0, skipped: [], opened: [] });
    expect(openFile).not.toHaveBeenCalled();
    expect(s.layout(A)).toBeFalsy();
    expect(s.tabs(A)).toEqual([]);
    expect((await s.restore(s1, "all", never)).fresh).toBe(0);
    expect(s.tabs(A)).toEqual([]);
  });

  it("reports an unknown worktree and restores the rest", async () => {
    const s = make();
    const report = await s.restore(snap({ [GONE]: one({ t1: shell() }), [B]: one({ t1: shell() }) }), "all", never, { known: (w) => w !== GONE });
    expect(report.skipped).toEqual([{ worktree: GONE, reason: "unknownWorktree" }]);
    expect(s.tabs(GONE)).toEqual([]);
    expect(s.tabs(B)).toHaveLength(1);
  });

  it("rebuilds the same shape and sizes with the new ids, and reopens files that exist", async () => {
    const s = make();
    const layout = {
      root: {
        kind: "split" as const, id: "s1", dir: "right" as const, sizes: [0.3, 0.7],
        children: [
          { kind: "leaf" as const, id: "p1", tabs: ["t1", "file:a.ts", "file:gone.ts"], active: "file:a.ts" },
          { kind: "leaf" as const, id: "p2", tabs: ["t2", "review:"], active: "t2" },
        ],
      },
      focused: "p2",
      expanded: null,
    };
    const tabs: Record<string, TabSnapshot> = { t1: claude({ agentSession: "a" }), t2: shell(), "file:a.ts": { kind: "file", rel: "a.ts" }, "file:gone.ts": { kind: "file", rel: "gone.ts" }, "review:": { kind: "review" } };
    await s.restore(snap({ [A]: { layout, tabs } }), "all", never, { openFile: async (_w, rel) => rel === "a.ts" });
    const got = s.layout(A)!;
    const [t1, t2] = s.tabs(A).map((t) => t.id);
    expect(got.focused).toBe("p2");
    expect(got.root.kind === "split" && got.root.sizes).toEqual([0.3, 0.7]);
    expect(leaves(got).map((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([[t1, "file:a.ts"], [t2, "review:"]]);
    expect(leaves(got).map((n) => (n.kind === "leaf" ? n.active : ""))).toEqual(["file:a.ts", t2]);
  });

  it("skips a worktree that already has tabs and a broken entry without stopping", async () => {
    const s = make();
    s.open(A, "shell");
    const bad = { layout: null, tabs: null } as unknown as LayoutSnapshot["worktrees"][string];
    const report = await s.restore(snap({ [A]: one({ t1: shell() }), [GONE]: bad, [B]: one({ t1: shell() }) }), "all", never);
    expect(s.tabs(A)).toHaveLength(1);
    expect(s.tabs(B)).toHaveLength(1);
    expect(report.fresh).toBe(1);
  });
});

describe("Sessions.restore lazy start", () => {
  it("marks restored tabs as deferred until they are removed; tabs opened by hand never are", async () => {
    const s = new Sessions(createMockApi({}));
    const mine = s.open(B, "shell");
    await s.restore(snap({ [A]: one({ t1: shell() }) }), "all", never);
    const restored = s.tabs(A)[0];
    expect(s.deferred(restored.id)).toBe(true);
    expect(s.deferred(mine.id)).toBe(false);
    await s.close(restored.id);
    expect(s.deferred(restored.id)).toBe(false);
    s.dispose();
  });
});

describe("Sessions.restore: worktrees that are not loaded", () => {
  let sessions: Sessions | null = null;
  const make = () => (sessions = new Sessions(createMockApi({})));
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  it("a worktree of a missing repo keeps its entry across saves", async () => {
    const s = make();
    const saved = snap({ [GONE]: one({ t1: shell() }), [B]: one({ t1: shell() }) });
    await s.restore(saved, "all", never, { known: (w) => w !== GONE, carry: () => true });
    expect(Object.keys(s.snapshot().worktrees).sort()).toEqual([B, GONE].sort());
    expect(Object.keys(s.snapshot().worktrees).sort()).toEqual([B, GONE].sort());
    expect(s.snapshot().worktrees[GONE]).toEqual(saved.worktrees[GONE]);
  });

  it("an entry the registry says is gone is dropped, and so is one removed later", async () => {
    const s = make();
    await s.restore(snap({ [GONE]: one({ t1: shell() }) }), "all", never, { known: () => false });
    expect(s.snapshot().worktrees).toEqual({});
    const t = make();
    await t.restore(snap({ [GONE]: one({ t1: shell() }) }), "all", never, { known: () => false, carry: () => true });
    expect(Object.keys(t.snapshot().worktrees)).toEqual([GONE]);
    t.dropCarried(GONE);
    expect(t.snapshot().worktrees).toEqual({});
  });
});

describe("Sessions.restore: the terminal service", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });
  const running = () => {
    const api = createMockApi({});
    api.__ptydSet({ state: "running", serviceVersion: "0.4.0" });
    return api;
  };

  it("attaches a tab whose pty is still live instead of spawning or resuming", async () => {
    const api = running();
    api.__ptydHold({ id: "live-1", output: "made while closed\r\n", info: { agent: true, profile: "claude", cli: "claude" } });
    const s = (sessions = new Sessions(api));
    const spawn = vi.spyOn(api, "ptySpawn");
    const attach = vi.spyOn(api, "ptyAttach");
    const resume = vi.spyOn(s, "resume");
    const report = await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "abc", title: "Fix it", pinned: true, ptyId: "live-1", seq: 3 }) }) }), "all", never);
    expect(attach).toHaveBeenCalledWith("live-1", 3, expect.any(Function));
    expect(resume).not.toHaveBeenCalled();
    expect(never).not.toHaveBeenCalled();
    expect(report).toMatchObject({ attached: 1, resumed: 0, fresh: 0, opened: ["live-1"] });
    const [tab] = s.tabs(A);
    expect(tab).toMatchObject({ id: "live-1", profileId: "claude", agent: true, agentSession: "abc", title: "Fix it", pinned: true, openedAt: 500 });
    // Shown later, the view binds to the attached pty.
    const got: Uint8Array[] = [];
    await tab.client.start(A, "claude", 80, 24, (b) => got.push(b));
    expect(spawn).not.toHaveBeenCalled();
    // From byte 3 on: what the tab had drawn before the app closed is not sent again.
    await vi.waitFor(() => expect(got.map((g) => new TextDecoder().decode(g)).join("")).toBe("e while closed\r\n"));
  });

  describe("sleeping tabs", () => {
    const make = () => (sessions = new Sessions(createMockApi({})));
    const asleep = (over: Partial<Extract<TabSnapshot, { kind: "terminal" }>> = {}) => claude({ asleep: true, agentSession: "abc", title: "Fix it", pinned: true, color: "c2", ...over });

    for (const mode of ["none", "agentsOnly", "all"] as const) {
      it(`comes back asleep under ${mode}, with no attach and no spawn`, async () => {
        const api = createMockApi({});
        const s = (sessions = new Sessions(api));
        const spawn = vi.spyOn(api, "ptySpawn");
        const attach = vi.spyOn(api, "ptyAttach");
        const report = await s.restore(snap({ [A]: one({ t1: asleep({ ptyId: "stale", seq: 4 }) }) }), mode, never);
        expect(spawn).not.toHaveBeenCalled();
        expect(attach).not.toHaveBeenCalled();
        expect(never).not.toHaveBeenCalled();
        expect(s.tabs(A)).toHaveLength(1);
        expect(s.tabs(A)[0]).toMatchObject({ asleep: true, agentSession: "abc", resumeOf: "abc", title: "Fix it", pinned: true, color: "c2", openedAt: 500 });
        expect(s.tabs(A)[0].id).not.toBe("stale");
        expect(report.opened).toEqual([s.tabs(A)[0].id]);
        expect(s.asleep(A)).toBe(true);
      });
    }

    it("under none the awake tabs of the same worktree still stay out", async () => {
      const s = make();
      await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "x" }), t2: asleep() }) }), "none", never);
      expect(s.tabs(A).map((t) => t.asleep)).toEqual([true]);
      expect(leaves(s.layout(A)!).flatMap((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([s.tabs(A)[0].id]);
    });

    it("under none the file tabs of a worktree with a sleeping tab come back too", async () => {
      const s = make();
      const openFile = vi.fn(async () => true);
      await s.restore(snap({ [A]: one({ t2: asleep(), "file:a.ts": { kind: "file", rel: "a.ts" } }) }), "none", never, { openFile });
      expect(openFile).toHaveBeenCalledWith(A, "a.ts");
    });

    it("a sleeping shell comes back asleep and wakes as a new shell", async () => {
      const s = make();
      await s.restore(snap({ [A]: one({ t1: shell({ asleep: true }) }) }), "agentsOnly", never);
      expect(s.tabs(A)[0]).toMatchObject({ asleep: true, profileId: "shell", resumeOf: null });
    });

    it("an agent that slept without a session wakes as a new one", async () => {
      const s = make();
      await s.restore(snap({ [A]: one({ t1: asleep({ agentSession: null }) }) }), "none", never);
      expect(s.tabs(A)[0]).toMatchObject({ asleep: true, agentSession: null });
      expect(s.wake(s.tabs(A)[0].id)).toMatchObject({ resumeOf: null });
    });
  });

  it("goes the resume way unchanged when the pty is gone", async () => {
    const api = running();
    const s = (sessions = new Sessions(api));
    const resume = vi.spyOn(s, "resume");
    const report = await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "abc", ptyId: "gone-1", seq: 9 }) }) }), "all", never);
    expect(resume).toHaveBeenCalledWith(A, "claude", null, "abc", null, "claude");
    expect(report).toMatchObject({ resumed: 1, fresh: 0 });
    expect(report.attached).toBeUndefined();
    expect(s.tabs(A)).toHaveLength(1);
    expect(s.tabs(A)[0].id).not.toBe("gone-1");
  });

  it("pty_gone primes snapshot and restored note", async () => {
    const api = running();
    api.__snapshotSet("gone-2", new TextEncoder().encode("old output\n"));
    const s = (sessions = new Sessions(api));
    await s.restore(snap({ [A]: one({ t1: shell({ ptyId: "gone-2", seq: 9 }) }) }), "all", never);
    const id = s.tabs(A)[0].id;
    const prime = takePrime(id);
    expect(new TextDecoder().decode(prime!.bytes!)).toBe("old output\n");
    expect(prime!.note).toBe(translate("en", "ptyd.restored"));
    // The old copy is handed over, not kept.
    expect(await api.ptySnapshot("gone-2")).toBeNull();
  });

  it("no snapshot gives fresh note", async () => {
    const s = (sessions = new Sessions(running()));
    await s.restore(snap({ [A]: one({ t1: shell({ ptyId: "gone-3", seq: 9 }) }) }), "all", never, { note: (key) => `[${key}]` });
    expect(takePrime(s.tabs(A)[0].id)).toEqual({ bytes: null, note: "[ptyd.fresh]" });
  });

  it("does not ask the service when it is off", async () => {
    const api = createMockApi({});
    const attach = vi.spyOn(api, "ptyAttach");
    const s = (sessions = new Sessions(api));
    const report = await s.restore(snap({ [A]: one({ t1: shell({ ptyId: "p", seq: 1 }) }) }), "all", never);
    expect(attach).not.toHaveBeenCalled();
    expect(report).toMatchObject({ fresh: 1 });
  });

  it("keeps an exit the service reports before the attach returns", async () => {
    const api = running();
    api.__ptydHold({ id: "done-1", output: "bye", info: { agent: true, profile: "claude", cli: "claude" } });
    const exits: ((e: { id: string; code: number | null }) => void)[] = [];
    const listen = api.onPtyExit.bind(api);
    api.onPtyExit = (cb) => {
      exits.push(cb);
      return listen(cb);
    };
    const attach = api.ptyAttach.bind(api);
    // Like Rust: the attach of a pty that has ended sends its exit event before the reply.
    vi.spyOn(api, "ptyAttach").mockImplementation(async (id, fromSeq, onData) => {
      const got = await attach(id, fromSeq, onData);
      for (const cb of exits) cb({ id, code: 3 });
      return got;
    });
    const s = (sessions = new Sessions(api));
    const report = await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "abc", ptyId: "done-1" }) }) }), "all", never);
    expect(report.attached).toBe(1);
    expect(s.tabs(A)[0]).toMatchObject({ id: "done-1", exitCode: 3 });
  });

  it("keeps the tab and attaches again on start when the attach fails for another reason", async () => {
    const api = running();
    api.__ptydHold({ id: "busy-1", output: "abcdef", info: { agent: true, profile: "claude", cli: "claude" } });
    const attach = api.ptyAttach.bind(api);
    const spy = vi.spyOn(api, "ptyAttach").mockRejectedValueOnce({ code: "ptyd_unreachable" });
    const spawn = vi.spyOn(api, "ptySpawn");
    const s = (sessions = new Sessions(api));
    const resume = vi.spyOn(s, "resume");
    const report = await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "abc", ptyId: "busy-1", seq: 2 }) }) }), "all", never);
    expect(resume).not.toHaveBeenCalled();
    expect(report).toMatchObject({ attached: 1, resumed: 0, fresh: 0 });
    const [tab] = s.tabs(A);
    expect(tab.id).toBe("busy-1");
    // A snapshot taken meanwhile keeps the seq the tab had drawn.
    expect(tab.client.seq).toBe(2);
    // The view's start attaches again, from the same seq, and never spawns a second pty.
    spy.mockImplementation(attach);
    const got: Uint8Array[] = [];
    await tab.client.start(A, "claude", 80, 24, (b) => got.push(b));
    expect(spy).toHaveBeenLastCalledWith("busy-1", 2, expect.any(Function));
    expect(spawn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(got.map((g) => new TextDecoder().decode(g)).join("")).toBe("cdef"));
  });

  it("surfaces a second failed attach as the start's error, without spawning", async () => {
    const api = running();
    api.__ptydHold({ id: "busy-2" });
    vi.spyOn(api, "ptyAttach").mockRejectedValue({ code: "ptyd_unreachable" });
    const spawn = vi.spyOn(api, "ptySpawn");
    const s = (sessions = new Sessions(api));
    await s.restore(snap({ [A]: one({ t1: shell({ ptyId: "busy-2" }) }) }), "all", never);
    const [tab] = s.tabs(A);
    await expect(tab.client.start(A, "shell", 80, 24, () => {})).rejects.toMatchObject({ code: "ptyd_unreachable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("attaches a live shell in agentsOnly too, which would otherwise skip it", async () => {
    const api = running();
    api.__ptydHold({ id: "sh-1" });
    const s = (sessions = new Sessions(api));
    const report = await s.restore(snap({ [A]: one({ t1: shell({ ptyId: "sh-1" }), t2: shell() }) }), "agentsOnly", never);
    expect(report.attached).toBe(1);
    expect(s.tabs(A).map((t) => t.id)).toEqual(["sh-1"]);
  });
});

describe("restored accounts", () => {
  // The mock's active Claude account is claude-2.
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });
  const restored = async (over: Partial<Extract<TabSnapshot, { kind: "terminal" }>>) => {
    const s = (sessions = new Sessions(createMockApi({})));
    await s.restore(snap({ [A]: one({ t1: claude({ agentSession: "abc", ...over }) }) }), "all", never);
    return s.tabs(A)[0];
  };

  it("a tab that followed the active account follows it again while it is still the active one", async () => {
    const tab = await restored({ account: "claude-2", accountSource: "active" });
    expect(tab.account).toBeNull();
  });

  it("a tab that followed the active account but would now get another is pinned to the saved one", async () => {
    const tab = await restored({ account: "claude-3", accountSource: "active" });
    expect(tab.account).toBe("claude-3");
  });

  it("a tab's own pick stays pinned, and an older snapshot's account is read as one", async () => {
    expect((await restored({ account: "claude-3", accountSource: "tab" })).account).toBe("claude-3");
    sessions?.dispose();
    expect((await restored({ account: "claude-3" })).account).toBe("claude-3");
  });

  it("restoredAccount: a profile's account is looked up again, and an unreadable active account does not pin", () => {
    const active = new Map<string, string | null>([["claude", "claude-2"]]);
    expect(restoredAccount({ account: "x", accountSource: "profile" }, "claude", active)).toBeNull();
    expect(restoredAccount({ account: "x", accountSource: "active" }, "claude", null)).toBeNull();
    expect(restoredAccount({ account: null, accountSource: "active" }, "claude", active)).toBe(null);
    expect(restoredAccount({ account: "claude-2", accountSource: "active" }, null, active)).toBeNull();
  });
});
