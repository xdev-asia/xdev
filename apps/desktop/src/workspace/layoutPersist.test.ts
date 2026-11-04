import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { LAYOUT_VERSION } from "./layoutSnapshot";
import { restoreLayout, SAVE_DEBOUNCE_MS, sessionFallback, startLayoutSave, undoRestore, watchWindowClose } from "./layoutPersist";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("layout save", () => {
  let sessions: Sessions | null = null;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    vi.useRealTimers();
  });

  it("three changes within a second make one save", () => {
    const api = createMockApi({});
    const save = vi.spyOn(api, "layoutSave");
    const s = (sessions = new Sessions(api));
    const saver = startLayoutSave(api, s);
    s.open(A, "shell");
    vi.advanceTimersByTime(400);
    s.open(A, "shell");
    vi.advanceTimersByTime(400);
    s.open(A, "shell");
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(Object.keys(save.mock.calls[0][0].worktrees)).toEqual([A]);
    saver.stop();
  });

  it("flush on close saves at once, and only when a change waits", () => {
    const api = createMockApi({});
    const save = vi.spyOn(api, "layoutSave");
    const s = (sessions = new Sessions(api));
    const saver = startLayoutSave(api, s);
    saver.flush();
    expect(save).not.toHaveBeenCalled();
    s.open(A, "shell");
    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
    saver.stop();
  });
});

describe("window close", () => {
  let sessions: Sessions | null = null;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    vi.useRealTimers();
  });

  it("a close request flushes the pending save; stopping removes the listener", async () => {
    const api = createMockApi({});
    const save = vi.spyOn(api, "layoutSave");
    const s = (sessions = new Sessions(api));
    const saver = startLayoutSave(api, s);
    let handler: (() => void | Promise<void>) | null = null;
    const unlisten = vi.fn();
    const win = {
      onCloseRequested: async (h: () => void | Promise<void>) => {
        handler = h;
        return unlisten;
      },
    };
    const stop = watchWindowClose(saver, win);
    await Promise.resolve();
    await Promise.resolve();
    s.open(A, "shell");
    await handler!();
    expect(save).toHaveBeenCalledTimes(1);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    saver.stop();
  });

  it("a guard that says no keeps the window open and saves nothing; yes saves and closes", async () => {
    const api = createMockApi({});
    const save = vi.spyOn(api, "layoutSave");
    const s = (sessions = new Sessions(api));
    const saver = startLayoutSave(api, s);
    let handler: ((e: { preventDefault(): void }) => void | Promise<void>) | null = null;
    const win = {
      onCloseRequested: async (h: (e: { preventDefault(): void }) => void | Promise<void>) => {
        handler = h;
        return () => {};
      },
    };
    let answer = false;
    const stop = watchWindowClose(saver, win, async () => answer);
    await Promise.resolve();
    await Promise.resolve();
    s.open(A, "shell");
    const kept = { preventDefault: vi.fn() };
    await handler!(kept);
    expect(kept.preventDefault).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    answer = true;
    const closed = { preventDefault: vi.fn() };
    await handler!(closed);
    expect(closed.preventDefault).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    stop();
    saver.stop();
  });

  it("is a no-op without a window", () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    const saver = startLayoutSave(api, s);
    expect(() => watchWindowClose(saver, null)()).not.toThrow();
    saver.stop();
  });
});

describe("restore at start", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  async function saved(api: ReturnType<typeof createMockApi>) {
    const first = new Sessions(api);
    first.open(A, "shell");
    first.resume(A, "claude", null, "abc");
    await api.layoutSave(first.snapshot());
    first.dispose();
  }

  it("a stored snapshot calls restore; Undo closes exactly the restored tabs", async () => {
    const api = createMockApi({});
    await saved(api);
    const s = (sessions = new Sessions(api));
    const mine = s.open("/demo/wt/xdev-elm", "shell");
    const restore = vi.spyOn(s, "restore");
    const got = await restoreLayout(api, s, () => true, async () => false);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(got).toMatchObject({ mode: "all", report: { resumed: 1, fresh: 1 } });
    expect(s.tabs(A)).toHaveLength(2);
    await undoRestore(s, got!.report.opened);
    expect(s.tabs(A)).toEqual([]);
    expect(s.tabs("/demo/wt/xdev-elm").map((t) => t.id)).toEqual([mine.id]);
  });

  it("nothing saved, mode none or a failing store restore nothing", async () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    const restore = vi.spyOn(s, "restore");
    expect(await restoreLayout(api, s, () => true, async () => false)).toBeNull();
    await saved(api);
    await api.uiSettingsPut({ ...(await api.uiSettingsGet()), restore: "none" });
    expect(await restoreLayout(api, s, () => true, async () => false)).toBeNull();
    api.layoutLoad = () => Promise.reject({ code: "io" });
    expect(await restoreLayout(api, s, () => true, async () => false)).toBeNull();
    expect(restore).not.toHaveBeenCalled();
  });

  it("a rejecting layoutLoad still returns null and marks layout.restore not ok", async () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    api.layoutLoad = () => Promise.reject(new Error("layout.json did not parse"));
    expect(await restoreLayout(api, s, () => true, async () => false)).toBeNull();
    const step = (await api.startupReport()).steps.find((x) => x.id === "layout.restore");
    expect(step).toMatchObject({ ok: false, detail: "layout.json did not parse" });
  });

  it("a clean restore marks layout.restore ok", async () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    await restoreLayout(api, s, () => true, async () => false);
    expect((await api.startupReport()).steps.find((x) => x.id === "layout.restore")?.ok).toBe(true);
  });

  it("the fallback asks the worktree's agent sessions and takes the newest resumable one since the tab opened", async () => {
    const api = createMockApi({});
    const rows = (...r: [string, number, boolean][]) =>
      r.map(([id, first, resumable]) => ({ session: { id, first }, resumable }) as never);
    const spy = vi.spyOn(api, "agentSessions").mockResolvedValue(rows(["new", 900, false], ["mid", 700, true], ["old", 100, true]));
    const fallback = sessionFallback(api);
    expect(await fallback(A, "claude", 500)).toBe("mid");
    expect(await fallback(A, "claude", 1000)).toBeNull();
    expect(await fallback(A, null, 0)).toBeNull();
    expect(spy.mock.calls[0][0]).toEqual({ text: null, scope: { kind: "worktree", path: A }, agent: "claude", homeId: null, sort: "firstDesc", limit: 5 });
    expect(LAYOUT_VERSION).toBe(1);
  });
});
