import { describe, expect, it, vi } from "vitest";
import type { ApiError, AutomationDispatch } from "@/api";
import { createMockApi } from "@/mockApi";
import type { Tab } from "@/workspace/sessions";
import { SNAPSHOT_LINES, START_DEADLINE_MS, startAutomationDispatch, type DispatchHost } from "./dispatch";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function dispatch(over: Partial<AutomationDispatch> = {}): AutomationDispatch {
  return { runId: "run-1", automationId: "a1", worktree: "/w", repoId: "r1", created: false, setup: "inherit", profile: "claude", prompt: "Audit the repo", extraArgs: [], reuseTab: null, ...over };
}

type Listener = () => void;

/** A tab store the dispatch client can drive: tabs are opened `idle`, and a test moves their status. */
function fakeHost(over: Partial<DispatchHost> = {}) {
  const tabs: Tab[] = [];
  const listeners = new Set<Listener>();
  const inputs: { id: string; text: string }[] = [];
  const opened: { worktree: string; profile: string; extraArgs?: string[] }[] = [];
  const errorListeners = new Map<string, Set<(e: ApiError) => void>>();
  const notify = () => [...listeners].forEach((l) => l());
  const mkTab = (id: string, worktree: string, over: Partial<Tab> = {}): Tab => {
    const client = {
      input: async (text: string) => void inputs.push({ id, text }),
      startError: null as ApiError | null,
      onStartError(cb: (e: ApiError) => void) {
        const set = errorListeners.get(id) ?? new Set();
        set.add(cb);
        errorListeners.set(id, set);
        return () => void set.delete(cb);
      },
    };
    return { id, worktree, agent: true, status: "idle", exitCode: undefined, client, ...over } as unknown as Tab;
  };
  const sessions = {
    tabs: (worktree: string) => tabs.filter((t) => t.worktree === worktree),
    subscribe(l: Listener) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    open(worktree: string, profile: string, _account?: string | null, _cli?: unknown, opts: { extraArgs?: string[] } = {}) {
      const tab = mkTab(`tab-${tabs.length + 1}`, worktree);
      tabs.push(tab);
      opened.push({ worktree, profile, ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}) });
      return tab;
    },
  };
  const host: DispatchHost = {
    sessions: sessions as unknown as DispatchHost["sessions"],
    setup: vi.fn(),
    ensureMounted: vi.fn(),
    defer: () => false,
    terminalLines: () => ["line one", "line two"],
    ...over,
  };
  /** Moves a tab through its statuses, telling the store each time. */
  const status = (tab: Tab, next: Tab["status"], extra: Partial<Tab> = {}) => {
    Object.assign(tab, { status: next }, extra);
    notify();
  };
  const refuse = (id: string, err: ApiError) => {
    for (const cb of errorListeners.get(id) ?? []) cb(err);
  };
  /** Starts the agent: working, then idle (ready), as `ready` waits for. */
  const ready = async (tab: Tab) => {
    status(tab, "working");
    status(tab, "idle");
    await flush();
  };
  return { host, tabs, inputs, opened, status, refuse, ready, mkTab, notify };
}

async function setup(host: DispatchHost) {
  const api = createMockApi({});
  const stop = startAutomationDispatch(api, host);
  await flush();
  return { api, stop };
}

describe("startAutomationDispatch", () => {
  it("tells the backend the window is ready", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    expect(api.__automationReady()).toBe(1);
  });

  it("opens a tab with the profile and extra arguments, types the prompt and reports it", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch({ extraArgs: ["--model", "opus"] }));
    await flush();
    expect(f.opened).toEqual([{ worktree: "/w", profile: "claude", extraArgs: ["--model", "opus"] }]);
    await f.ready(f.tabs[0]);
    expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0].text).toContain("Audit the repo");
    expect(api.__automationReports().results).toEqual([{ status: "dispatched", runId: "run-1", tabId: "tab-1" }]);
  });

  it("leaves extra arguments out when there are none", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    expect(f.opened[0]).not.toHaveProperty("extraArgs");
  });

  it("sets up a worktree made for the run, by its decision", async () => {
    for (const setupDecision of ["inherit", "run", "skip"] as const) {
      const f = fakeHost();
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch({ created: true, setup: setupDecision, repoId: "repo-9" }));
      await flush();
      expect(f.host.setup).toHaveBeenCalledWith("/w", "repo-9", setupDecision);
    }
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch({ created: false }));
    await flush();
    expect(f.host.setup).not.toHaveBeenCalled();
  });

  it("mounts the worktree before setup and before the tab opens", async () => {
    const order: string[] = [];
    const f = fakeHost({
      ensureMounted: (w) => void order.push(`mount ${w}`),
      setup: (w) => void order.push(`setup ${w}`),
    });
    const open = f.host.sessions.open.bind(f.host.sessions);
    (f.host.sessions as { open: typeof open }).open = (...args: Parameters<typeof open>) => {
      order.push(`open ${args[0]}`);
      return open(...args);
    };
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch({ worktree: "/new", created: true }));
    await flush();
    expect(order).toEqual(["mount /new", "setup /new", "open /new"]);
  });

  it("waits for setup when the repo says so", async () => {
    let go: (() => void) | null = null;
    const f = fakeHost({ defer: (_w, launch) => ((go = launch), true) });
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    expect(f.opened).toEqual([]);
    go!();
    await flush();
    expect(f.opened).toHaveLength(1);
  });

  it("reuses the previous tab when it is open and idle or done", async () => {
    for (const status of ["idle", "done"] as const) {
      const f = fakeHost();
      const old = f.mkTab("old", "/w", { status });
      f.tabs.push(old);
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch({ reuseTab: "old" }));
      await flush();
      expect(f.opened).toEqual([]);
      expect(f.inputs.map((i) => i.id)).toEqual(["old"]);
      expect(api.__automationReports().results).toEqual([{ status: "dispatched", runId: "run-1", tabId: "old" }]);
    }
  });

  it("opens a fresh tab when the previous one is busy, gone or ended", async () => {
    for (const old of [{ status: "working" as const }, { status: "idle" as const, exitCode: 0 }, null]) {
      const f = fakeHost();
      if (old) f.tabs.push(f.mkTab("old", "/w", old));
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch({ reuseTab: "old" }));
      await flush();
      expect(f.opened).toHaveLength(1);
      expect(f.inputs).toEqual([]);
    }
  });

  it("reports needsApproval when the spawn is refused by the gate", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    f.refuse("tab-1", { code: "needs_approval", detail: "start claude in a terminal" });
    await flush();
    expect(api.__automationReports().results).toEqual([{ status: "failed", runId: "run-1", code: "needsApproval", detail: "start claude in a terminal" }]);
  });

  it("does not type the prompt into a refused tab that starts later", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    f.refuse("tab-1", { code: "needs_approval", detail: "start claude in a terminal" });
    await flush();
    // The person approves in the tab afterwards: the run is already recorded as skipped.
    await f.ready(f.tabs[0]);
    expect(f.inputs).toEqual([]);
    expect(api.__automationReports().results).toHaveLength(1);
  });

  it("reports agentNeverStarted for another start failure and for a tab that ends before it is ready", async () => {
    const a = fakeHost();
    const first = await setup(a.host);
    first.api.__automationDispatch(dispatch());
    await flush();
    a.refuse("tab-1", { code: "io", detail: "no such program" });
    await flush();
    expect(first.api.__automationReports().results[0]).toMatchObject({ status: "failed", code: "agentNeverStarted" });

    const b = fakeHost();
    const second = await setup(b.host);
    second.api.__automationDispatch(dispatch());
    await flush();
    b.status(b.tabs[0], "exited", { exitCode: 1 });
    await flush();
    expect(second.api.__automationReports().results[0]).toMatchObject({ status: "failed", code: "agentNeverStarted" });
  });

  it("finishes a run when the tab works and then is done, with the terminal's lines", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    f.status(f.tabs[0], "working");
    f.status(f.tabs[0], "done");
    await flush();
    expect(api.__automationReports().finishes).toEqual([{ runId: "run-1", completed: true, output: "line one\nline two", truncated: false }]);
  });

  it("marks the output as cut when the terminal gave as many lines as asked for", async () => {
    const f = fakeHost({ terminalLines: (_id, max) => Array.from({ length: max }, (_, i) => `l${i}`) });
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    f.status(f.tabs[0], "working");
    f.status(f.tabs[0], "done");
    await flush();
    expect(api.__automationReports().finishes[0]).toMatchObject({ completed: true, truncated: true });
  });

  it("keeps a terminal of exactly the kept lines as not cut", async () => {
    const f = fakeHost({ terminalLines: (_id, max) => Array.from({ length: Math.min(max, SNAPSHOT_LINES) }, (_, i) => `l${i}`) });
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    f.status(f.tabs[0], "working");
    f.status(f.tabs[0], "done");
    await flush();
    const [finish] = api.__automationReports().finishes;
    expect(finish).toMatchObject({ completed: true, truncated: false });
    expect(finish.output!.split("\n")).toHaveLength(SNAPSHOT_LINES);
  });

  it("does not complete a run for a done that came before any work", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    f.status(f.tabs[0], "done");
    await flush();
    expect(api.__automationReports().finishes).toEqual([]);
  });

  it("fails a run whose tab exits or fails first, without output", async () => {
    for (const [status, extra] of [["exited", { exitCode: 1 }], ["failed", {}]] as const) {
      const f = fakeHost();
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch());
      await flush();
      await f.ready(f.tabs[0]);
      f.status(f.tabs[0], status, extra);
      await flush();
      expect(api.__automationReports().finishes).toEqual([{ runId: "run-1", completed: false, output: null, truncated: false }]);
    }
  });

  it("fails a run whose tab is closed", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    f.tabs.length = 0;
    f.notify();
    await flush();
    expect(api.__automationReports().finishes[0]).toMatchObject({ completed: false });
  });

  it("reports one result and one finish per run even if the tab flips status twice", async () => {
    const f = fakeHost();
    const { api } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    for (let i = 0; i < 2; i++) {
      f.status(f.tabs[0], "working");
      f.status(f.tabs[0], "done");
    }
    f.status(f.tabs[0], "exited", { exitCode: 0 });
    await flush();
    expect(api.__automationReports().results).toHaveLength(1);
    expect(api.__automationReports().finishes).toHaveLength(1);
  });

  it("fails a run whose agent never starts working on the prompt", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeHost();
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch());
      await flush();
      await f.ready(f.tabs[0]);
      expect(api.__automationReports().results).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - 1);
      expect(api.__automationReports().results).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      const { results, finishes } = api.__automationReports();
      expect(results[1]).toEqual({ status: "failed", runId: "run-1", code: "agentNeverStarted", detail: null });
      expect(finishes).toEqual([]);
      // Nothing more is reported when the tab ends afterwards.
      f.status(f.tabs[0], "exited", { exitCode: 0 });
      await flush();
      expect(api.__automationReports().finishes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a new agent tab the full start deadline to get ready", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeHost();
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch());
      await flush();
      // Past the 30 s a prompt sent by hand waits, still inside the run's start deadline.
      await vi.advanceTimersByTimeAsync(START_DEADLINE_MS - 5_000);
      expect(api.__automationReports().results).toEqual([]);
      await f.ready(f.tabs[0]);
      expect(api.__automationReports().results).toEqual([{ status: "dispatched", runId: "run-1", tabId: "tab-1" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail a run whose agent started working in time", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeHost();
      const { api } = await setup(f.host);
      api.__automationDispatch(dispatch());
      await flush();
      await f.ready(f.tabs[0]);
      f.status(f.tabs[0], "working");
      await vi.advanceTimersByTimeAsync(START_DEADLINE_MS * 5);
      expect(api.__automationReports().results).toHaveLength(1);
      f.status(f.tabs[0], "done");
      await flush();
      expect(api.__automationReports().finishes[0]).toMatchObject({ completed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a run's watcher once the run ends", async () => {
    const f = fakeHost();
    const sessions = f.host.sessions as { subscribe(l: Listener): () => void };
    const subscribe = sessions.subscribe.bind(sessions);
    const unsubscribed: number[] = [];
    sessions.subscribe = (l: Listener) => {
      const i = unsubscribed.push(0) - 1;
      const off = subscribe(l);
      return () => {
        unsubscribed[i]++;
        off();
      };
    };
    const { api, stop } = await setup(f.host);
    api.__automationDispatch(dispatch());
    await flush();
    await f.ready(f.tabs[0]);
    f.status(f.tabs[0], "working");
    f.status(f.tabs[0], "done");
    await flush();
    expect(api.__automationReports().finishes).toHaveLength(1);
    // Stopping later does not run the ended watcher's stop again.
    stop();
    expect(unsubscribed.every((n) => n === 1)).toBe(true);
  });

  it("stops listening when stopped", async () => {
    const f = fakeHost();
    const { api, stop } = await setup(f.host);
    stop();
    await flush();
    api.__automationDispatch(dispatch());
    await flush();
    expect(f.opened).toEqual([]);
  });
});
