import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { Sessions } from "@/workspace/sessions";
import { AgentSessionsStore, REFRESH_MS } from "./store";

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
