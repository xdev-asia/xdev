import { afterEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { createMockConversation } from "@/conversation/mockConversation";
import { ROSTER_MS, Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

let sessions: Sessions | null = null;
afterEach(() => {
  sessions?.dispose();
  sessions = null;
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const api = createMockApi({});
  const runs = createMockConversation(() => 0);
  runs.__conversationFixture("subagents");
  const live = (sessions = new Sessions(api));
  // A fresh list each read, as from the backend.
  const read = vi.spyOn(api, "agentSubagents").mockImplementation((session) => runs.agentSubagents(session));
  return { api, live, read };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

it("hooks_of_a_claude_tab_read_its_sub_agents_once_per_window", async () => {
  const { api, live, read } = setup();
  const tab = live.open(A, "claude");
  api.__hook(tab.id, "prompt", undefined, "s-1");
  api.__hook(tab.id, "resume", { toolName: "Task", isInterrupt: false } as never, "s-1");
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(ROSTER_MS);
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith("s-1");
  const runs = live.tabs(A)[0].subagents!;
  expect(runs.map((r) => [r.id, r.status])).toEqual([["task-a", "ok"], ["task-b", "error"]]);
  expect(runs[0]).not.toHaveProperty("steps");
  expect(runs[0]).not.toHaveProperty("prompt");
});

it("an_unchanged_roster_stays_the_same_and_a_failed_read_keeps_the_last", async () => {
  const { api, live, read } = setup();
  const tab = live.open(A, "claude");
  api.__hook(tab.id, "prompt", undefined, "s-1");
  await vi.advanceTimersByTimeAsync(ROSTER_MS);
  await flush();
  const first = live.tabs(A)[0].subagents;
  api.__hook(tab.id, "turn-done", undefined, "s-1");
  await vi.advanceTimersByTimeAsync(ROSTER_MS);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(live.tabs(A)[0].subagents).toBe(first);
  read.mockRejectedValueOnce({ code: "io" });
  api.__hook(tab.id, "prompt", undefined, "s-1");
  await vi.advanceTimersByTimeAsync(ROSTER_MS);
  await flush();
  expect(live.tabs(A)[0].subagents).toHaveLength(2);
});

it("a_tab_without_a_session_or_not_claude_reads_nothing", async () => {
  const { api, live, read } = setup();
  const codex = live.open(A, "codex");
  const claude = live.open(A, "claude");
  api.__hook(codex.id, "turn-done", undefined, "c-1");
  api.__hook(claude.id, "prompt");
  await vi.advanceTimersByTimeAsync(ROSTER_MS * 2);
  expect(read).not.toHaveBeenCalled();
  expect(live.tabs(A).every((t) => t.subagents === undefined)).toBe(true);
});

it("closing_the_tab_drops_its_pending_read", async () => {
  const { api, live, read } = setup();
  const tab = live.open(A, "claude");
  api.__hook(tab.id, "prompt", undefined, "s-1");
  await live.close(tab.id);
  await vi.advanceTimersByTimeAsync(ROSTER_MS * 2);
  expect(read).not.toHaveBeenCalled();
});
