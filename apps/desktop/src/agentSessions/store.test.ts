import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { Sessions } from "@/workspace/sessions";
import { AgentSessionsStore, DEFAULT_VIEW, PAGE, POLL_MS, READING_MS, REFRESH_MS, VIEW_KEY } from "./store";

const A = "/demo/wt/xdev-oak";

describe("AgentSessionsStore", () => {
  let store: AgentSessionsStore | null = null;
  let sessions: Sessions | null = null;
  afterEach(() => {
    store?.dispose();
    sessions?.dispose();
    store = sessions = null;
    vi.useRealTimers();
  });

  it("refresh asks Rust to re-read the logs and keeps the rows", async () => {
    const api = createMockApi({});
    const ask = vi.spyOn(api, "agentSessions");
    store = new AgentSessionsStore(api, null);
    await store.refresh();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "all" }, sort: "lastDesc" }), true);
    expect(store.state.rows.length).toBeGreaterThan(3);
    expect(store.state.loading).toBe(false);
  });

  it("setQuery reads the index without re-reading the logs", async () => {
    const api = createMockApi({});
    const ask = vi.spyOn(api, "agentSessions");
    store = new AgentSessionsStore(api, null);
    await store.setQuery({ text: "parser" });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: "parser" }), false);
    expect(store.state.rows.map((r) => r.session.id)).toEqual(["0b1e6f3a-demo-0001"]);
  });

  it("a content hit reaches the rows only after the person turned the search on", async () => {
    const api = createMockApi({});
    store = new AgentSessionsStore(api, null);
    await store.setQuery({ text: "backslash" });
    expect(store.state.rows).toEqual([]);
    expect(store.state.contentSearch).toBe(false);
    await api.agentsSettingsPut({ ...(await api.agentsSettings()), sessionSearch: true });
    await store.setQuery({ text: "backslash" });
    expect(store.state.contentSearch).toBe(true);
    expect(store.state.rows).toHaveLength(1);
    expect(store.state.rows[0].hit).toBe("The <mark>backslash</mark> in the fixture path breaks the glob");
  });

  it("tells subscribers and hands the same state until something changes", async () => {
    store = new AgentSessionsStore(createMockApi({}), null);
    const heard = vi.fn();
    store.subscribe(heard);
    const before = store.state;
    expect(store.state).toBe(before);
    await store.refresh();
    expect(heard).toHaveBeenCalled();
    expect(store.state).not.toBe(before);
  });

  it("an older answer does not replace a newer one", async () => {
    const api = createMockApi({});
    const real = api.agentSessions.bind(api);
    let release: () => void = () => {};
    vi.spyOn(api, "agentSessions").mockImplementationOnce(async (q, r) => {
      await new Promise<void>((resolve) => (release = resolve));
      return real(q, r);
    });
    store = new AgentSessionsStore(api, null);
    const slow = store.setQuery({ text: "zzz-nothing" });
    await store.setQuery({ text: "parser" });
    release();
    await slow;
    expect(store.state.query.text).toBe("parser");
    expect(store.state.rows.map((r) => r.session.id)).toEqual(["0b1e6f3a-demo-0001"]);
  });

  it("a failed read shows as the error and keeps the old rows", async () => {
    const api = createMockApi({});
    store = new AgentSessionsStore(api, null);
    await store.refresh();
    const rows = store.state.rows;
    vi.spyOn(api, "agentSessions").mockRejectedValueOnce({ code: "io", detail: "x" });
    await store.refresh();
    expect(store.state.error).toEqual({ code: "io", detail: "x" });
    expect(store.state.rows).toBe(rows);
  });

  it("watch refreshes now and every 60 s until stopped", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const ask = vi.spyOn(api, "agentSessions");
    store = new AgentSessionsStore(api, null);
    const stop = store.watch();
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("two refreshes at once ask Rust to read the logs once", async () => {
    const api = createMockApi({});
    const ask = vi.spyOn(api, "agentSessions");
    store = new AgentSessionsStore(api, null);
    const first = store.refresh();
    const second = store.refresh();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(ask).toHaveBeenCalledTimes(1);
    await store.refresh();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("a long refresh says it is reading and shows the rows read so far", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const real = api.agentSessions.bind(api);
    let release: () => void = () => {};
    const ask = vi.spyOn(api, "agentSessions").mockImplementationOnce(async (q, r) => {
      await new Promise<void>((resolve) => (release = resolve));
      return real(q, r);
    });
    store = new AgentSessionsStore(api, null);
    const done = store.refresh();
    await vi.advanceTimersByTimeAsync(READING_MS - 1);
    expect(store.state.reading).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.state.reading).toBe(true);
    expect(ask).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(store.state.rows.length).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(ask).toHaveBeenCalledTimes(3);
    release();
    await done;
    expect(store.state.reading).toBe(false);
    expect(store.state.loading).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("a query changed during a refresh is read again when it ends", async () => {
    const api = createMockApi({});
    const real = api.agentSessions.bind(api);
    let release: () => void = () => {};
    const ask = vi.spyOn(api, "agentSessions").mockImplementationOnce(async (q, r) => {
      await new Promise<void>((resolve) => (release = resolve));
      return real(q, r);
    });
    store = new AgentSessionsStore(api, null);
    const done = store.refresh();
    await store.setQuery({ text: "parser" });
    release();
    await done;
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ text: "parser" }), false);
    expect(store.state.rows.map((r) => r.session.id)).toEqual(["0b1e6f3a-demo-0001"]);
  });

  it("refreshes once when an agent tab exits, not for a shell", async () => {
    const api = createMockApi({});
    const live = (sessions = new Sessions(api));
    const ask = vi.spyOn(api, "agentSessions");
    store = new AgentSessionsStore(api, live);
    await api.ptyApprove("claude", null);
    const agent = live.open(A, "claude");
    await agent.client.start(A, "claude", 80, 24, () => {});
    const shell = live.open(A, "shell");
    await shell.client.start(A, "shell", 80, 24, () => {});
    // The store listens through a promise; let it settle.
    await Promise.resolve();
    await shell.client.input("exit\r");
    await vi.waitFor(() => expect(live.tab(shell.id)?.exitCode).toBe(0));
    expect(ask).not.toHaveBeenCalled();
    await agent.client.input("exit\r");
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(expect.anything(), true);
  });
});

describe("AgentSessionsStore search and paging", () => {
  let store: AgentSessionsStore | null = null;
  afterEach(() => {
    store?.dispose();
    store = null;
    vi.useRealTimers();
  });

  it("search waits 150 ms after the last key, then asks once", async () => {
    vi.useFakeTimers();
    const api = createMockApi({});
    const ask = vi.spyOn(api, "agentSessions");
    store = new AgentSessionsStore(api, null);
    store.search("pa");
    await vi.advanceTimersByTimeAsync(100);
    store.search("parser");
    await vi.advanceTimersByTimeAsync(149);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: "parser" }), false);
  });

  it("an empty search clears the text", async () => {
    vi.useFakeTimers();
    store = new AgentSessionsStore(createMockApi({}), null);
    store.search("  ");
    await vi.advanceTimersByTimeAsync(150);
    expect(store.state.query.text).toBeNull();
  });

  it("remembers every home it has seen, so a home filter does not hide its own switch", async () => {
    store = new AgentSessionsStore(createMockApi({}), null);
    await store.refresh();
    expect(store.state.homes).toEqual(["acct-claude-2", "own-claude", "own-codex"]);
    await store.setQuery({ homeId: "own-codex" });
    expect(store.state.homes).toEqual(["acct-claude-2", "own-claude", "own-codex"]);
  });

  it("loadMore raises the limit by one page, up to 500, and says when there is more", async () => {
    const api = createMockApi({});
    store = new AgentSessionsStore(api, null);
    await store.setQuery({ limit: 3 });
    expect(store.state.more).toBe(true);
    await store.loadMore();
    expect(store.state.query.limit).toBe(3 + PAGE);
    expect(store.state.more).toBe(false);
    await store.setQuery({ limit: 500 });
    await store.loadMore();
    expect(store.state.query.limit).toBe(500);
  });
});

describe("the saved view", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("starts from the defaults, keeps a change, and a new store reads it back", () => {
    const storage = memory();
    vi.stubGlobal("localStorage", storage);
    const first = new AgentSessionsStore(createMockApi({}), null);
    expect(first.view).toEqual(DEFAULT_VIEW);
    const listener = vi.fn();
    first.subscribe(listener);
    first.setView({ groupBy: "folder", history: 30 });
    expect(listener).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.data.get(VIEW_KEY) ?? "null")).toEqual({ groupBy: "folder", hideEmpty: true, history: 30 });
    expect(new AgentSessionsStore(createMockApi({}), null).view).toEqual({ groupBy: "folder", hideEmpty: true, history: 30 });
    first.dispose();
  });

  it("falls back to the defaults on bad text or no storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"groupBy":"nope","history":5}', setItem: () => {} });
    expect(new AgentSessionsStore(createMockApi({}), null).view).toEqual(DEFAULT_VIEW);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const store = new AgentSessionsStore(createMockApi({}), null);
    expect(store.view).toEqual(DEFAULT_VIEW);
    store.setView({ hideEmpty: false });
    expect(store.view.hideEmpty).toBe(false);
  });
});

