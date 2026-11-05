import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, SetEntry, TerminalSet } from "@/api";
import type { Tab } from "@/workspace/sessions";
import { openCopy, openEntry, openMany, openSet, type OpenContext } from "./launch";
import { resetStartupMemory, startupOf } from "./startupMemory";

type Fake = Tab & { fail(e: ApiError): void };

function world() {
  const opened: { worktree: string; profile: string; opts?: unknown }[] = [];
  const tabs: Fake[] = [];
  const sessions = {
    open(worktree: string, profile: string, _a: unknown, _c: unknown, opts?: unknown) {
      opened.push({ worktree, profile, opts });
      const cbs = new Set<(e: ApiError) => void>();
      const client = {
        startError: null as ApiError | null,
        spawned: true,
        input: vi.fn(async (_: string) => {}),
        typeWhenReady: vi.fn(),
        onStartError: (cb: (e: ApiError) => void) => {
          cbs.add(cb);
          return () => void cbs.delete(cb);
        },
      };
      const tab = {
        id: `t${tabs.length}`,
        worktree,
        profileId: profile,
        agent: !profile.startsWith("shell"),
        status: "idle",
        exitCode: undefined,
        client,
        fail: (e: ApiError) => {
          client.startError = e;
          cbs.forEach((cb) => cb(e));
        },
      } as unknown as Fake;
      tabs.push(tab);
      return tab as Tab;
    },
    tabs: (w: string) => tabs.filter((t) => t.worktree === w) as Tab[],
    subscribe: () => () => {},
    close: vi.fn(async () => {}),
  };
  const ctx: OpenContext = {
    sessions,
    worktree: "/w",
    worktrees: [{ path: "/x", label: "feature" }],
    defaultShell: "shell:bash",
    sleep: async () => {},
    graceMs: 0,
    staggerMs: 0,
  };
  return { opened, tabs, ctx };
}

beforeEach(() => resetStartupMemory());

describe("openMany", () => {
  it("opens every index and reports none failed", async () => {
    const w = world();
    const copy = { profile: "claude", worktree: "/w", prompt: null, overrides: null, startup: [] };
    const { done } = openMany([0, 1, 2], (i) => openCopy(w.ctx, copy, undefined, i), w.ctx);
    expect(await done).toEqual({ tried: 3, total: 3, failed: [] });
    expect(w.opened).toHaveLength(3);
  });

  it("counts a thrown open and a late start error as failed, but not needs_approval", async () => {
    const w = world();
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms === 400 ? 400 : 0));
    const { done, tabs } = openMany(
      [0, 1, 2, 3],
      (i) => {
        if (i === 0) throw new Error("x");
        return w.ctx.sessions.open("/w", "claude", null, undefined);
      },
      { ...w.ctx, sleep: wait, graceMs: 400 },
    );
    await new Promise((r) => setTimeout(r, 100));
    (tabs.get(1) as unknown as Fake).fail({ code: "io" } as ApiError);
    (tabs.get(2) as unknown as Fake).fail({ code: "needs_approval" } as ApiError);
    expect((await done).failed).toEqual([0, 1]);
  });
});

describe("openCopy", () => {
  it("passes the prompt and overrides, and remembers the startup", () => {
    const w = world();
    const steps = [{ command: "ls", wait: { type: "none" as const } }];
    const overrides = { model: "m", effort: null, extraArgs: [] };
    const tab = openCopy(w.ctx, { profile: "claude", worktree: "/w", prompt: "hi", overrides, startup: steps }, undefined, 0);
    expect(w.opened[0].opts).toEqual({ prompt: "hi", overrides });
    expect(startupOf(tab.id)).toEqual(steps);
  });
});

describe("openEntry", () => {
  const entry = (over: Partial<SetEntry>): SetEntry => ({ target: { type: "agent", profile: "claude" }, worktree: { type: "current" }, startup: [], ...over });

  it("opens an agent in the current or a named worktree", () => {
    const w = world();
    openEntry(w.ctx, entry({}), 0);
    openEntry(w.ctx, entry({ worktree: { type: "named", name: "Feature" } }), 1);
    expect(w.opened.map((o) => o.worktree)).toEqual(["/w", "/x"]);
  });

  it("throws for an unknown worktree and for a shell entry without a shell", () => {
    const w = world();
    expect(() => openEntry(w.ctx, entry({ worktree: { type: "named", name: "nope" } }), 0)).toThrow("worktree");
    expect(() => openEntry({ ...w.ctx, defaultShell: null }, entry({ target: { type: "shell", command: "", shell: null } }), 0)).toThrow("shell");
  });

  it("types a shell command first, then the startup steps", async () => {
    const w = world();
    const tab = openEntry(
      w.ctx,
      entry({ target: { type: "shell", command: "npm run dev", shell: null }, startup: [{ command: "echo", wait: { type: "none" } }] }),
      0,
    );
    await new Promise((r) => setTimeout(r, 0));
    const calls = (tab.client.input as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["npm run dev\r", "echo\r"]);
  });
});

describe("openSet", () => {
  it("opens every entry", async () => {
    const w = world();
    const entries: SetEntry[] = [0, 1].map(() => ({ target: { type: "agent", profile: "claude" }, worktree: { type: "current" }, startup: [] }));
    const set: TerminalSet = { id: "s", name: "n", entries };
    expect((await openSet(w.ctx, set).done).total).toBe(2);
    expect(w.opened).toHaveLength(2);
  });
});
