import { afterEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { SETUP_PROFILE } from "@/api";
import { SetupGate } from "./setupGate";
import { Sessions } from "./sessions";

const WT = "/demo/wt/xdev-oak";

let sessions: Sessions | null = null;
afterEach(() => {
  sessions?.dispose();
  sessions = null;
});

// A setup tab that has (or has not) exited; the exit is applied the way the pty event would.
function setup(exit?: number | null) {
  const api = createMockApi({});
  sessions = new Sessions(api);
  const tab = sessions.open(WT, SETUP_PROFILE);
  const finish = (code: number | null) => (sessions as unknown as { apply(id: string, e: { kind: "exit"; code: number | null }): void }).apply(tab.id, { kind: "exit", code });
  if (exit !== undefined) finish(exit);
  const gate = new SetupGate();
  const off = gate.attach(sessions);
  return { sessions, tab, gate, finish, off };
}

it("a setup tab does not count as an agent for the worktree's status", () => {
  const { tab } = setup();
  expect(tab.agent).toBe(false);
});

it("waits for the setup tab, then starts the agent on exit 0", () => {
  const { tab, gate, finish } = setup();
  gate.track(WT, tab.id, true);
  const start = vi.fn();
  expect(gate.defer(WT, start)).toBe(true);
  expect(gate.state(WT)).toEqual({ phase: "running" });
  expect(start).not.toHaveBeenCalled();
  finish(0);
  expect(start).toHaveBeenCalledOnce();
  expect(gate.state(WT)).toBeNull();
});

it("a failure keeps the agent waiting and shows the code; Start anyway starts it", () => {
  const { tab, gate, finish } = setup();
  gate.track(WT, tab.id, true);
  const start = vi.fn();
  gate.defer(WT, start);
  finish(3);
  expect(start).not.toHaveBeenCalled();
  expect(gate.state(WT)).toEqual({ phase: "failed", code: 3 });
  gate.startNow(WT);
  expect(start).toHaveBeenCalledOnce();
  expect(gate.state(WT)).toBeNull();
});

it("Start now skips the wait", () => {
  const { tab, gate } = setup();
  gate.track(WT, tab.id, true);
  const start = vi.fn();
  gate.defer(WT, start);
  gate.startNow(WT);
  expect(start).toHaveBeenCalledOnce();
  expect(gate.defer(WT, vi.fn())).toBe(false);
});

it("does not wait when the repo says not to", () => {
  const { tab, gate } = setup();
  gate.track(WT, tab.id, false);
  expect(gate.defer(WT, vi.fn())).toBe(false);
  expect(gate.state(WT)).toBeNull();
});

it("checks the exit that arrived before it was tracked", () => {
  const { tab, gate } = setup(0);
  gate.track(WT, tab.id, true);
  expect(gate.defer(WT, vi.fn())).toBe(false);
});

it("a setup tab that closed releases the waiting agent", () => {
  const { sessions, tab, gate } = setup();
  gate.track(WT, tab.id, true);
  const start = vi.fn();
  gate.defer(WT, start);
  void sessions.close(tab.id);
  expect(start).toHaveBeenCalledOnce();
});

it("tells listeners when the state changes", () => {
  const { tab, gate, finish } = setup();
  const seen = vi.fn();
  gate.subscribe(seen);
  gate.track(WT, tab.id, true);
  gate.defer(WT, vi.fn());
  const before = seen.mock.calls.length;
  finish(1);
  expect(seen.mock.calls.length).toBeGreaterThan(before);
});
