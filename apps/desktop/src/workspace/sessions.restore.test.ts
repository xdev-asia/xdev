import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { LAYOUT_VERSION, type LayoutSnapshot, type TabSnapshot } from "./layoutSnapshot";
import { leaves } from "./paneTree";
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
    const s1 = snap({ [A]: one({ t1: shell() }) });
    expect(await s.restore(s1, "none", never)).toEqual({ resumed: 0, fresh: 0, skipped: [], opened: [] });
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

  it("does not ask the service when it is off", async () => {
    const api = createMockApi({});
    const attach = vi.spyOn(api, "ptyAttach");
    const s = (sessions = new Sessions(api));
    const report = await s.restore(snap({ [A]: one({ t1: shell({ ptyId: "p", seq: 1 }) }) }), "all", never);
    expect(attach).not.toHaveBeenCalled();
    expect(report).toMatchObject({ fresh: 1 });
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
