import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api";

const decode = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join("");

describe("mock terminal service", () => {
  it("is off by default: attach is pty_gone and the list is empty", async () => {
    const api = createMockApi({});
    expect(await api.ptydStatus()).toEqual({ state: "off", serviceVersion: null, reason: null, features: [] });
    await expect(api.ptyAttach("t1", 0, () => {})).rejects.toMatchObject({ code: "pty_gone" });
    expect(await api.ptydSessions()).toEqual([]);
    await expect(api.ptydEnd("t1")).rejects.toMatchObject({ code: "ptyd_unreachable" });
  });

  it("snapshot set, read, cleared", async () => {
    const api = createMockApi({});
    expect(await api.ptySnapshot("t1")).toBeNull();
    api.__snapshotSet("t1", new TextEncoder().encode("old\n"));
    expect(decode([(await api.ptySnapshot("t1"))!])).toBe("old\n");
    await api.ptySnapshotClear("t1");
    expect(await api.ptySnapshot("t1")).toBeNull();
    await expect(api.ptydClearScrollback("t1")).rejects.toMatchObject({ code: "ptyd_unreachable" });
    api.__ptydSet({ state: "running", serviceVersion: "0.4.0", features: ["clear"] });
    api.__ptydHold({ id: "t1", output: "before" });
    api.__snapshotSet("t1", new Uint8Array([1]));
    await api.ptydClearScrollback("t1");
    expect(await api.ptySnapshot("t1")).toBeNull();
    await expect(api.ptydClearScrollback("nope")).rejects.toMatchObject({ code: "pty_gone" });
  });

  it("attaches to a held pty and replays from the seq", async () => {
    const api = createMockApi({});
    api.__ptydSet({ state: "running", serviceVersion: "0.4.0" });
    api.__ptydHold({ id: "t1", output: "hello world", info: { agent: true, profile: "claude" } });
    const chunks: Uint8Array[] = [];
    const attached = await api.ptyAttach("t1", 6, (b) => chunks.push(b));
    expect(attached).toMatchObject({ seq: 6, truncated: false, info: { id: "t1", agent: true, profile: "claude" } });
    await vi.waitFor(() => expect(decode(chunks)).toBe("world"));
    // The tab takes input like any terminal.
    await api.ptyWrite("t1", new TextEncoder().encode("x"));
    expect(decode(chunks)).toBe("worldx");
    await expect(api.ptyAttach("t1", 0, () => {})).rejects.toMatchObject({ code: "pty_exists" });
  });

  it("reports a cut ring as truncated", async () => {
    const api = createMockApi({});
    api.__ptydSet({ state: "running" });
    api.__ptydHold({ id: "t1", output: "tail", lost: 100 });
    expect(await api.ptyAttach("t1", 0, () => {})).toMatchObject({ seq: 100, truncated: true });
  });

  it("lists, ends and restarts", async () => {
    const api = createMockApi({});
    api.__ptydSet({ state: "running" });
    api.__ptydHold({ id: "a", meta: { worktree: "/w", tabId: "a", profile: "claude" } });
    api.__ptydHold({ id: "b" });
    const sessions = await api.ptydSessions();
    expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(sessions[0]).toMatchObject({ cwd: "/w", attached: false, exited: null, meta: { profile: "claude" } });
    const exits: string[] = [];
    await api.onPtyExit((e) => exits.push(e.id));
    await api.ptyAttach("a", 0, () => {});
    await api.ptydEnd("a");
    expect(exits).toEqual(["a"]);
    await api.ptydEndAll();
    expect(await api.ptydSessions()).toEqual([]);
  });

  it("fires ptyd://status and restarts into running", async () => {
    const api = createMockApi({});
    const seen: string[] = [];
    const stop = await api.onPtydStatus((s) => seen.push(s.state));
    api.__ptydSet({ state: "fallback", reason: "ptyd_start_failed" });
    expect(await api.ptydStatus()).toMatchObject({ state: "fallback", reason: "ptyd_start_failed" });
    await api.ptydRestart();
    expect(seen).toEqual(["fallback", "running"]);
    stop();
  });

  it("records the quit choice", async () => {
    const api = createMockApi({});
    expect(api.__quitChoice()).toBeNull();
    await api.ptydQuitChoice(true);
    expect(api.__quitChoice()).toBe(true);
  });
});
