import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api";

const tab = { id: "t1", worktree: "/w", title: null, profile: "claude", agent: true, status: "working", lastOutputMs: 5, exited: false };

describe("mock app CLI", () => {
  it("records tab reports and answers", async () => {
    const api = createMockApi({});
    await api.cliTabsReport([tab], "/w");
    await api.cliApprove(3, true);
    expect(api.__cliReports()).toEqual([{ tabs: [tab], selected: "/w" }]);
    expect(api.__cliAnswers()).toEqual([{ request: 3, allow: true }]);
  });

  it("delivers the endpoint's events until unlistened", async () => {
    const api = createMockApi({});
    const changed = vi.fn();
    const opened = vi.fn();
    const asked = vi.fn();
    const offChanged = await api.onWorkspaceChanged(changed);
    await api.onCliOpenTab(opened);
    await api.onCliAsk(asked);
    api.__cliWorkspaceChanged();
    api.__cliOpenTab({ worktree: "/w", profile: "claude", prompt: "hi" });
    api.__cliAsk({ request: 1, caller: null, verb: "worktree.set", target: "/w" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith({ worktree: "/w", profile: "claude", prompt: "hi" });
    expect(asked).toHaveBeenCalledWith({ request: 1, caller: null, verb: "worktree.set", target: "/w" });
    offChanged();
    api.__cliWorkspaceChanged();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

it("plays the orchestration events and records what the UI answers", async () => {
  const api = createMockApi({});
  const opens: string[] = [];
  const stop = await api.onOrchestrationOpenWorker((e) => opens.push(e.tab));
  api.__orchOpenWorker({ dispatch: "d1", tab: "t1", title: "worker", worktree: "w", profile: "claude", prompt: "p", setup: "skip", readyTimeoutMs: 1000 });
  stop();
  api.__orchOpenWorker({ dispatch: "d2", tab: "t2", title: "worker", worktree: "w", profile: "claude", prompt: "p", setup: "skip", readyTimeoutMs: 1000 });
  expect(opens).toEqual(["t1"]);
  await api.orchestrationWorkerOpened("d1", { kind: "ok" });
  await api.orchestrationReadAnswer(3, "text");
  expect(api.__orchOpened()).toEqual([{ dispatch: "d1", outcome: { kind: "ok" } }]);
  expect(api.__orchReads()).toEqual([{ request: 3, text: "text" }]);
  expect(await api.orchestrationWorkerLifetime("t1")).toBeNull();
  expect(await api.orchestrationWorkerKeepOpen("t1", true)).toMatchObject({ kept: true });
  expect((await api.orchestrationSkillInstall(true)).installed).toBe(true);
  expect(api.__orchInstalls()).toEqual([true]);
});
