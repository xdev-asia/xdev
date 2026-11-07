import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@/api";
import { createMockApi } from "@/mockApi";

const restoreBrowserTab = vi.fn((_w: string, url: string) => `browser:${url}`);
const browserListeners = new Set<() => void>();
vi.mock("@/browser/browserTabs", () => ({
  openBrowserTab: () => "browser:new",
  closeBrowserTab: () => {},
  browserTab: (id: string) => ({ id, url: id.replace("browser:", ""), title: "T" }),
  restoreBrowserTab: (...a: [string, string, string | null]) => restoreBrowserTab(...a),
  subscribeBrowserTabs: (l: () => void) => {
    browserListeners.add(l);
    return () => void browserListeners.delete(l);
  },
}));

const pty = vi.hoisted(() => ({
  attach: vi.fn(async (_from: number) => {}),
  attachOnStart: vi.fn(),
  made: [] as string[],
}));
vi.mock("@/terminal/ptyClient", () => ({
  PtyClient: class {
    seq = 0;
    constructor(
      _api: unknown,
      readonly id: string,
    ) {
      pty.made.push(id);
    }
    attach(from: number) {
      return pty.attach(from);
    }
    attachOnStart(from: number) {
      pty.attachOnStart(from);
    }
    async dispose() {}
  },
}));

import { FLOATING_WORKTREE, addFloatingTab, floatingState, resetFloatingForTests, setNoteBody } from "./floatingStore";
import {
  FLOATING_SAVE_DEBOUNCE_MS,
  loadFloating,
  resetFloatingPersistForTests,
  startFloatingSave,
  withFloatingSave,
} from "./floatingPersist";

const TERM = /^floating-term-[0-9a-f-]{36}$/;
const snap = (tabs: unknown[], active: number | null = 0) => ({ version: 1, savedAt: "2026-11-07T00:00:00Z", active, tabs });
const term = { kind: "terminal", id: "floating-term-a", n: 4, cwd: "/work", seq: 10 };

interface Opts {
  saved?: unknown;
  state?: string;
  restore?: string;
  save?: () => Promise<void>;
}
function makeApi(o: Opts = {}) {
  const base = createMockApi({});
  const spies = {
    floatingLoad: vi.fn(async () => o.saved ?? null),
    floatingSave: vi.fn(o.save ?? (async () => {})),
    ptydStatus: vi.fn(async () => ({ state: o.state ?? "running", serviceVersion: null, reason: null, features: [] })),
    ptydEnd: vi.fn(async () => {}),
    uiSettingsGet: vi.fn(async () => ({ ...(await base.uiSettingsGet()), restore: o.restore ?? "all" })),
  };
  return { api: { ...base, ...spies } as unknown as Api, ...spies };
}

function stubStorage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

beforeEach(() => {
  resetFloatingForTests();
  resetFloatingPersistForTests();
  restoreBrowserTab.mockClear();
  browserListeners.clear();
  pty.attach.mockReset().mockResolvedValue(undefined);
  pty.attachOnStart.mockClear();
  pty.made.length = 0;
  stubStorage({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loadFloating", () => {
  it("attaches a terminal the service holds and keeps its id", async () => {
    const { api } = makeApi({ saved: snap([term]) });
    await loadFloating(api);
    expect(pty.attach).toHaveBeenCalledWith(10);
    expect(floatingState().tabs).toEqual([{ id: "floating-term-a", kind: "terminal", n: 4, cwd: "/work" }]);
    expect(floatingState().open).toBe(false);
  });

  it("pty_gone brings the tab back with a new id and the saved cwd", async () => {
    pty.attach.mockRejectedValue({ code: "pty_gone" });
    const { api } = makeApi({ saved: snap([term]) });
    await loadFloating(api);
    const [tab] = floatingState().tabs;
    expect(tab.id).toMatch(TERM);
    expect(tab.id).not.toBe("floating-term-a");
    expect(tab.cwd).toBe("/work");
    expect(pty.attach).toHaveBeenCalledTimes(1);
  });

  it("another attach error attaches on start and keeps the id", async () => {
    pty.attach.mockRejectedValue({ code: "ptyd_unreachable" });
    const { api } = makeApi({ saved: snap([term]) });
    await loadFloating(api);
    expect(pty.attachOnStart).toHaveBeenCalledWith(10);
    expect(floatingState().tabs[0].id).toBe("floating-term-a");
  });

  it("a stopped service means no attach and a fresh tab with a new id", async () => {
    const { api } = makeApi({ saved: snap([term]), state: "off" });
    await loadFloating(api);
    expect(pty.attach).not.toHaveBeenCalled();
    expect(floatingState().tabs[0].id).toMatch(TERM);
    expect(floatingState().tabs[0].id).not.toBe("floating-term-a");
  });

  it("restore none drops terminals, ends their ptys, and keeps browsers and notes", async () => {
    const { api, ptydEnd } = makeApi({
      restore: "none",
      saved: snap([term, { kind: "browser", url: "https://a.test" }, { kind: "note", n: 1, body: "x" }], 0),
    });
    await loadFloating(api);
    expect(ptydEnd).toHaveBeenCalledWith("floating-term-a");
    expect(floatingState().tabs.map((t) => t.kind)).toEqual(["browser", "note"]);
    expect(floatingState().active).toBe(floatingState().tabs[0].id);
  });

  it("restores browser rows through restoreBrowserTab", async () => {
    const { api } = makeApi({ saved: snap([{ kind: "browser", url: "https://a.test", title: "A" }]) });
    await loadFloating(api);
    expect(restoreBrowserTab).toHaveBeenCalledWith(FLOATING_WORKTREE, "https://a.test", "A");
    expect(floatingState().tabs[0].id).toBe("browser:https://a.test");
  });

  it("keeps the saved active tab", async () => {
    const { api } = makeApi({ saved: snap([{ kind: "note", n: 1, body: "a" }, { kind: "note", n: 2, body: "b" }], 1) });
    await loadFloating(api);
    expect(floatingState().active).toBe(floatingState().tabs[1].id);
    expect(floatingState().tabs[1].body).toBe("b");
  });

  it("moves the legacy note in, and removes its key only after a save that succeeds", async () => {
    const store = stubStorage({ "xdev.floating.note.v1": "old text" });
    const ok = makeApi();
    await loadFloating(ok.api);
    expect(floatingState().tabs).toMatchObject([{ kind: "note", n: 1, body: "old text" }]);
    expect(store.has("xdev.floating.note.v1")).toBe(true);
    const saver = startFloatingSave(ok.api);
    await saver.flush(true);
    expect(store.has("xdev.floating.note.v1")).toBe(false);
    saver.stop();
  });

  it("a failed save keeps the legacy key", async () => {
    const store = stubStorage({ "xdev.floating.note.v1": "old text" });
    const bad = makeApi({ save: async () => Promise.reject({ code: "io" }) });
    await loadFloating(bad.api);
    const saver = startFloatingSave(bad.api);
    await saver.flush(true);
    expect(bad.floatingSave).toHaveBeenCalled();
    expect(store.has("xdev.floating.note.v1")).toBe(true);
    saver.stop();
  });

  it("does not use the legacy note when the snapshot has notes", async () => {
    stubStorage({ "xdev.floating.note.v1": "old text" });
    const { api } = makeApi({ saved: snap([{ kind: "note", n: 1, body: "new" }]) });
    await loadFloating(api);
    expect(floatingState().tabs).toHaveLength(1);
    expect(floatingState().tabs[0].body).toBe("new");
  });

  it("a failing or garbage load gives an empty store and does not throw", async () => {
    const failing = makeApi();
    failing.floatingLoad.mockRejectedValue({ code: "io" });
    await expect(loadFloating(failing.api)).resolves.toBeUndefined();
    expect(floatingState().tabs).toEqual([]);
    const garbage = makeApi({ saved: "not a snapshot" });
    await expect(loadFloating(garbage.api)).resolves.toBeUndefined();
    expect(floatingState().tabs).toEqual([]);
    const saver = startFloatingSave(garbage.api);
    saver.stop();
  });
});

describe("startFloatingSave", () => {
  it("saves once, 1000 ms after a change, not at 999", async () => {
    vi.useFakeTimers();
    const { api, floatingSave } = makeApi();
    const saver = startFloatingSave(api);
    addFloatingTab("note");
    await vi.advanceTimersByTimeAsync(FLOATING_SAVE_DEBOUNCE_MS - 1);
    expect(floatingSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(floatingSave).toHaveBeenCalledTimes(1);
    saver.stop();
  });

  it("a browser page change also schedules a save", async () => {
    vi.useFakeTimers();
    const { api, floatingSave } = makeApi();
    const saver = startFloatingSave(api);
    browserListeners.forEach((l) => l());
    await vi.advanceTimersByTimeAsync(FLOATING_SAVE_DEBOUNCE_MS);
    expect(floatingSave).toHaveBeenCalledTimes(1);
    saver.stop();
  });

  it("flush saves at once and cancels the timer", async () => {
    vi.useFakeTimers();
    const { api, floatingSave } = makeApi();
    const saver = startFloatingSave(api);
    const id = addFloatingTab("note") as string;
    setNoteBody(id, "typed");
    await saver.flush();
    expect(floatingSave).toHaveBeenCalledTimes(1);
    expect(floatingSave.mock.calls[0][0]).toMatchObject({ version: 1, tabs: [{ kind: "note", body: "typed" }] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(floatingSave).toHaveBeenCalledTimes(1);
    await saver.flush();
    expect(floatingSave).toHaveBeenCalledTimes(1);
    saver.stop();
  });

  it("stop unsubscribes", async () => {
    vi.useFakeTimers();
    const { api, floatingSave } = makeApi();
    const saver = startFloatingSave(api);
    saver.stop();
    addFloatingTab("note");
    await vi.advanceTimersByTimeAsync(5000);
    expect(floatingSave).not.toHaveBeenCalled();
    expect(browserListeners.size).toBe(0);
  });
});

describe("withFloatingSave", () => {
  it("flushes the floating saver when there is no layout saver", async () => {
    const { api, floatingSave } = makeApi();
    const saver = startFloatingSave(api);
    addFloatingTab("note");
    await withFloatingSave(null).flush();
    expect(floatingSave).toHaveBeenCalledTimes(1);
    saver.stop();
  });

  it("awaits both flushes", async () => {
    const { api, floatingSave } = makeApi();
    const saver = startFloatingSave(api);
    addFloatingTab("note");
    let layoutDone = false;
    const layout = {
      flush: () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            layoutDone = true;
            r();
          }, 20),
        ),
    };
    await withFloatingSave(layout).flush();
    expect(layoutDone).toBe(true);
    expect(floatingSave).toHaveBeenCalledTimes(1);
    saver.stop();
  });
});
