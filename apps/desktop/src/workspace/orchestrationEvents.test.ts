import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import type { WorkerOpen } from "@/api";
import { translate } from "@/i18n";
import { getToasts, resetToastsForTests } from "./toastStore";
import { openFailedToast, openWorker, readTab, startOrchestrationEvents, type OrchestrationHost } from "./orchestrationEvents";
import type { Tab } from "./sessions";

const flush = () => new Promise((r) => setTimeout(r, 0));
const OPEN: WorkerOpen = { dispatch: "disp_1", tab: "tab-1", title: "worker-task_1", worktree: "/w/a", profile: "claude", prompt: "do it", setup: "inherit", readyTimeoutMs: 60_000 };

function host(over: Partial<OrchestrationHost> = {}) {
  const tabs = new Map<string, Tab>();
  const open = vi.fn((worktree: string, profile: string, _a: unknown, _c: unknown, opts: { id?: string; title?: string; background?: boolean }) => {
    const tab = { id: opts.id!, worktree, profileId: profile } as Tab;
    tabs.set(tab.id, tab);
    return tab;
  });
  const close = vi.fn(async (id: string) => void tabs.delete(id));
  const send = vi.fn(async (_w: string, id: string, _text: string, _ms: number) => tabs.get(id) ?? null);
  const h: OrchestrationHost = {
    sessions: { open, close, tab: (id: string) => tabs.get(id) ?? null } as never,
    gate: { defer: () => false, state: () => null },
    send,
    terminal: () => null,
    ...over,
  };
  return { h, open, close, send, tabs };
}

describe("openWorker", () => {
  it("opens a background tab with the given id and title, sends the preamble, answers ok", async () => {
    const { h, open, send } = host({ now: () => 5 });
    const api = createMockApi({});
    expect(await openWorker(api, h, OPEN)).toEqual({ kind: "ok" });
    expect(open).toHaveBeenCalledWith("/w/a", "claude", null, undefined, { id: "tab-1", title: "worker-task_1", background: true });
    expect(send).toHaveBeenCalledWith("/w/a", "tab-1", "do it", 60_000);
  });

  it("mounts the worktree before the tab is made", async () => {
    const order: string[] = [];
    const { h, open } = host({ ensureMounted: (w) => void order.push(`mount ${w}`) });
    open.mockImplementation((w: string, _p: string, _a: unknown, _c: unknown, o: { id?: string }) => (order.push("open"), { id: o.id!, worktree: w } as Tab));
    await openWorker(createMockApi({}), h, OPEN);
    expect(order).toEqual(["mount /w/a", "open"]);
  });

  it("terminal_create when the tab cannot be made", async () => {
    const failed = vi.fn();
    const { h, send } = host({ failed });
    h.sessions.open = () => {
      throw new Error("no pty");
    };
    expect(await openWorker(createMockApi({}), h, OPEN)).toEqual({ kind: "failed", stage: "terminal_create", error: "no pty" });
    expect(failed).toHaveBeenCalledWith(OPEN, "terminal_create", "no pty");
    expect(send).not.toHaveBeenCalled();
  });

  it("agent_readiness when the agent never starts", async () => {
    const { h } = host({ send: async () => null });
    const out = await openWorker(createMockApi({}), h, OPEN);
    expect(out).toMatchObject({ kind: "failed", stage: "agent_readiness" });
  });

  it("dispatch_input when the paste throws", async () => {
    const { h } = host({
      send: async () => {
        throw new Error("write failed");
      },
    });
    expect(await openWorker(createMockApi({}), h, OPEN)).toEqual({ kind: "failed", stage: "dispatch_input", error: "write failed" });
  });

  it("waits for setup, then opens; the readiness budget is what is left", async () => {
    let launch: (() => void) | undefined;
    let t = 1_000;
    const { h, open, send } = host({ gate: { defer: (_w: string, l: () => void) => ((launch = l), true), state: () => ({ phase: "running" }) }, now: () => t });
    const pending = openWorker(createMockApi({}), h, OPEN);
    await flush();
    expect(open).not.toHaveBeenCalled();
    t += 10_000;
    launch!();
    expect(await pending).toEqual({ kind: "ok" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![3]).toBe(50_000);
  });

  it("setup_wait when setup does not finish in time, and the held launch never runs", async () => {
    vi.useFakeTimers();
    try {
      let launch: (() => void) | undefined;
      const { h, open } = host({ gate: { defer: (_w: string, l: () => void) => ((launch = l), true), state: () => ({ phase: "failed", code: 1, agent: true, tabs: false }) } });
      const pending = openWorker(createMockApi({}), h, { ...OPEN, readyTimeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toMatchObject({ kind: "failed", stage: "setup_wait", error: "setup failed" });
      launch!();
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prepares setup before it asks the gate, so a worktree the backend made gets its setup", async () => {
    const order: string[] = [];
    const { h } = host({
      prepareSetup: async (w) => void order.push(`prepare ${w}`),
      gate: { defer: () => (order.push("defer"), false), state: () => null },
    });
    expect(await openWorker(createMockApi({}), h, OPEN)).toEqual({ kind: "ok" });
    expect(order).toEqual(["prepare /w/a", "defer"]);
  });

  it("skip does not prepare setup", async () => {
    const prepareSetup = vi.fn(async () => {});
    const { h } = host({ prepareSetup });
    await openWorker(createMockApi({}), h, { ...OPEN, setup: "skip" });
    expect(prepareSetup).not.toHaveBeenCalled();
  });

  it("an agent that is unknown, off or not installed fails as terminal_create", async () => {
    const api = createMockApi({});
    vi.spyOn(api, "profiles").mockResolvedValue({
      defaultAgent: "claude",
      profiles: [
        { profile: { id: "claude", enabled: false }, installed: true },
        { profile: { id: "codex", enabled: true }, installed: false },
      ],
    } as never);
    const { h, open } = host();
    for (const profile of ["", "nope", "claude", "codex"]) {
      expect(await openWorker(api, h, { ...OPEN, profile })).toEqual({ kind: "failed", stage: "terminal_create", error: `agent ${profile} is not available` });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("skip bypasses the setup gate", async () => {
    const defer = vi.fn(() => true);
    const { h, open } = host({ gate: { defer, state: () => null } });
    expect(await openWorker(createMockApi({}), h, { ...OPEN, setup: "skip" })).toEqual({ kind: "ok" });
    expect(defer).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("readTab", () => {
  const lines = ["alpha", "beta", "gamma"];
  const term = (id: string) => (id === "t" ? { lines: () => lines } : null);
  it("joins the lines and keeps the end when it is cut", () => {
    const { h } = host({ terminal: term });
    expect(readTab(h, { request: 1, tab: "t", maxChars: 1000 })).toBe("alpha\nbeta\ngamma");
    expect(readTab(h, { request: 1, tab: "t", maxChars: 6 })).toBe("\ngamma");
  });
  it("does not start the cut text with half a character", () => {
    const { h } = host({ terminal: () => ({ lines: () => ["a\u{1F600}b"] }) });
    // Cutting after "a" and the first half of the emoji would leave a lone half; it is dropped.
    expect(readTab(h, { request: 1, tab: "t", maxChars: 2 })).toBe("b");
    expect(readTab(h, { request: 1, tab: "t", maxChars: 3 })).toBe("\u{1F600}b");
  });
  it("readTab uses maxLines when it is set", () => {
    const asked: number[] = [];
    const { h } = host({ terminal: () => ({ lines: (n: number) => (asked.push(n), ["one", "two"]) }) });
    expect(readTab(h, { request: 1, tab: "t", maxChars: 2, maxLines: 30 })).toBe("one\ntwo");
    expect(asked).toEqual([30]);
  });
  it("an unknown tab and a zero budget give an empty text", () => {
    const { h } = host({ terminal: term });
    expect(readTab(h, { request: 1, tab: "nope", maxChars: 100 })).toBe("");
    expect(readTab(h, { request: 1, tab: "t", maxChars: 0 })).toBe("");
  });
});

describe("startOrchestrationEvents", () => {
  it("answers an open once, even when the event repeats while it is under way", async () => {
    const api = createMockApi({});
    const { h, open } = host();
    const stop = startOrchestrationEvents(api, h);
    await flush();
    api.__orchOpenWorker(OPEN);
    api.__orchOpenWorker(OPEN);
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(api.__orchOpened()).toEqual([{ dispatch: "disp_1", outcome: { kind: "ok" } }]);
    stop();
  });

  it("closes a known tab and ignores a missing one", async () => {
    const api = createMockApi({});
    const { h, close, tabs } = host();
    tabs.set("tab-9", { id: "tab-9" } as Tab);
    startOrchestrationEvents(api, h);
    await flush();
    api.__orchCloseWorker({ dispatch: "d", tab: "gone" });
    api.__orchCloseWorker({ dispatch: "d", tab: "tab-9" });
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("tab-9");
  });

  it("answers a read with the cut text, and with an empty one for an unknown tab", async () => {
    const api = createMockApi({});
    const { h } = host({ terminal: (id) => (id === "t" ? { lines: () => ["one", "two"] } : null) });
    startOrchestrationEvents(api, h);
    await flush();
    api.__orchReadTab({ request: 7, tab: "t", maxChars: 4 });
    api.__orchReadTab({ request: 8, tab: "x", maxChars: 4 });
    await flush();
    expect(api.__orchReads()).toEqual([{ request: 7, text: "\ntwo" }, { request: 8, text: "" }]);
  });

  it("stops following when stopped", async () => {
    const api = createMockApi({});
    const { h, open } = host();
    startOrchestrationEvents(api, h)();
    await flush();
    api.__orchOpenWorker(OPEN);
    await flush();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("openFailedToast", () => {
  it("setup_wait is worded for a setup that failed and one that did not finish", () => {
    expect(translate("en", "orchestration.worker.stage.setup_wait")).toBe("setup did not finish");
    expect(translate("vi", "orchestration.worker.stage.setup_wait")).toBe("thiết lập chưa xong");
  });

  it("names the worker and the stage, in both languages", () => {
    resetToastsForTests();
    const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
    openFailedToast(OPEN, "agent_readiness", t);
    expect(getToasts().map((x) => x.text)).toEqual(["Could not open worker worker-task_1: the agent was not ready in time"]);
    for (const stage of ["terminal_create", "setup_start", "agent_readiness", "setup_wait", "dispatch_input"]) {
      for (const locale of ["en", "vi"] as const) {
        const key = `orchestration.worker.stage.${stage}`;
        expect(translate(locale, key), `${locale} ${key}`).not.toBe(key);
      }
    }
    resetToastsForTests();
  });
});
