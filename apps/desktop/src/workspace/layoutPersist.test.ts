import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { LAYOUT_VERSION } from "./layoutSnapshot";
import { restoreLayout, SAVE_DEBOUNCE_MS, sessionFallback, startLayoutSave, undoRestore } from "./layoutPersist";
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
