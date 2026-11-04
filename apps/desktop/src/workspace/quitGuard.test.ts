import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { askQuit, guardClose, installCloseGuard, quitAsk } from "./quitGuard";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("quitAsk", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });
  const tabs = () => {
    const s = (sessions = new Sessions(createMockApi({})));
    const agent = s.open(A, "claude");
    s.rename(agent.id, "Fix the parser");
    s.open(A, "shell");
    return s.tabs(A).map((t) => (t.id === agent.id ? { ...t, status: "working" as const } : t));
  };

  it("asks only for Ask, with the service running and a tab alive", () => {
    const all = tabs();
    const ask = quitAsk("ask", "running", all)!;
    expect(ask.count).toBe(2);
    expect(ask.working.map((w) => w.title)).toEqual(["Fix the parser"]);
    expect(quitAsk("ask", "old-version", all)?.count).toBe(2);
    expect(quitAsk("keep", "running", all)).toBeNull();
    expect(quitAsk("end", "running", all)).toBeNull();
    // In the app, terminals end with it anyway: nothing to choose.
    expect(quitAsk("ask", "fallback", all)).toBeNull();
    expect(quitAsk("ask", "off", all)).toBeNull();
    expect(quitAsk("ask", "running", [])).toBeNull();
  });

  it("does not count tabs that exited", () => {
    const all = tabs().map((t, i) => (i === 1 ? { ...t, exitCode: 0 } : t));
    expect(quitAsk("ask", "running", all)?.count).toBe(1);
  });
});

describe("askQuit", () => {
  it("lets the close go on with no question, and records the answer when there is one", async () => {
    const api = createMockApi({});
    api.__ptydSet({ state: "running" });
    const tab = { id: "t", title: null, profileId: "shell", status: "idle", exitCode: undefined } as never;
    const show = vi.fn(async () => "end" as const);
    expect(await askQuit(api, () => "keep", () => [tab], show)).toBe(true);
    expect(show).not.toHaveBeenCalled();
    expect(await askQuit(api, () => "ask", () => [tab], show)).toBe(true);
    expect(show).toHaveBeenCalledWith({ count: 1, working: [] });
    expect(api.__quitChoice()).toBe(true);
    expect(await askQuit(api, () => "ask", () => [tab], async () => "keep")).toBe(true);
    expect(api.__quitChoice()).toBe(false);
    expect(await askQuit(api, () => "ask", () => [tab], async () => "cancel")).toBe(false);
  });
});

describe("guardClose", () => {
  const notice = { title: "xDev", body: "xDev is still running in the system tray." };

  it("asks the shell first and stands down when it hid the window", async () => {
    const api = createMockApi({});
    api.__closeIntent("hide");
    const ask = vi.fn(async () => true);
    expect(await guardClose(api, notice, ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("goes on to the quit question on a close, and lets it end the app", async () => {
    const api = createMockApi({});
    const ask = vi.fn(async () => true);
    expect(await guardClose(api, notice, ask)).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("tells the shell when the person cancels, so it stops treating the close as a quit", async () => {
    const api = createMockApi({});
    await api.shellQuit("end-all");
    expect(api.__quitMode()).toBe("end-all");
    expect(await guardClose(api, notice, async () => false)).toBe(false);
    expect(api.__quitMode()).toBeNull();
  });

  it("closes when the shell does not answer", async () => {
    const api = createMockApi({});
    api.shellCloseRequested = async () => {
      throw new Error("no shell");
    };
    expect(await guardClose(api, notice, async () => true)).toBe(true);
  });
});

describe("installCloseGuard", () => {
  type Handler = (e: { preventDefault(): void }) => void | Promise<void>;
  const fakeWindow = () => {
    const box: { handler: Handler | null } = { handler: null };
    return {
      box,
      win: {
        onCloseRequested: async (h: Handler) => {
          box.handler = h;
          return () => {};
        },
      },
    };
  };
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("guards a close before any saver exists (welcome screen, restore still running)", async () => {
    const { box, win } = fakeWindow();
    const guard = vi.fn(async () => false);
    installCloseGuard(win, () => null, guard);
    await settle();
    const event = { preventDefault: vi.fn() };
    await box.handler!(event);
    expect(guard).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("closes without a saver when the guard agrees", async () => {
    const { box, win } = fakeWindow();
    installCloseGuard(win, () => null, async () => true);
    await settle();
    const event = { preventDefault: vi.fn() };
    await box.handler!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("flushes the saver that exists when the close fires", async () => {
    const { box, win } = fakeWindow();
    let saver: { flush: () => Promise<void> } | null = null;
    installCloseGuard(win, () => saver, async () => true);
    await settle();
    const flush = vi.fn(async () => {});
    saver = { flush };
    await box.handler!({ preventDefault: () => {} });
    expect(flush).toHaveBeenCalledOnce();
  });
});
