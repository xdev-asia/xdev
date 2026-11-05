import { describe, expect, it, vi } from "vitest";
import { createMockApi, type AutomationInput } from "./api";
import { mockDescribe } from "./mockAutomations";

const NOW = 1_793_793_600_000;

function input(over: Partial<AutomationInput> = {}): AutomationInput {
  return {
    name: "Audit", prompt: "Look", precheck: null, agent: "claude", extraAgentArgs: null, repoId: "r1", workspaceMode: "existing", worktree: "/w", baseBranch: null,
    setupDecision: "inherit", reuseSession: false, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", dtstart: NOW, enabled: true, missedRunGraceMinutes: 720, ...over,
  };
}


describe("mock automations", () => {
  it("creates, updates, pauses and deletes", async () => {
    const api = createMockApi({});
    const a = await api.automationCreate(input({ name: "  " }));
    expect(a.name).toBe("Untitled automation");
    expect((await api.automationsList()).automations).toHaveLength(1);
    const b = await api.automationUpdate(a.id, input({ name: "Nightly" }));
    expect(b).toMatchObject({ id: a.id, name: "Nightly" });
    expect((await api.automationSetEnabled(a.id, false)).enabled).toBe(false);
    await api.automationDelete(a.id);
    expect((await api.automationsList()).automations).toEqual([]);
    await expect(api.automationDelete(a.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(api.automationUpdate("nope", input())).rejects.toMatchObject({ code: "not_found" });
  });

  it("applies the run location rules like Rust", async () => {
    const api = createMockApi({});
    const fresh = await api.automationCreate(input({ workspaceMode: "new_per_run", reuseSession: true, worktree: "/w", baseBranch: "main", precheck: { command: " ls ", timeoutSeconds: 9999 } }));
    expect(fresh).toMatchObject({ reuseSession: false, worktree: null, baseBranch: "main", precheck: { command: "ls", timeoutSeconds: 600 } });
    expect((await api.automationCreate(input({ baseBranch: "main", precheck: { command: " ", timeoutSeconds: 60 } }))).baseBranch).toBeNull();
  });

  it("records a manual run and lists it as the last one", async () => {
    const api = createMockApi({});
    const a = await api.automationCreate(input());
    const run = await api.automationRunNow(a.id);
    expect(run).toMatchObject({ automationId: a.id, runNumber: 1, trigger: "manual", status: "dispatching" });
    expect(run.title).toBe("Audit run 1");
    // A second run waits for the first to end.
    await expect(api.automationRunNow(a.id)).rejects.toMatchObject({ code: "bad_arg", detail: "previousRunActive" });
    await api.automationRunFinish({ runId: run.id, completed: true, output: null, truncated: false });
    expect((await api.automationRunNow(a.id)).runNumber).toBe(2);
    expect((await api.automationRuns(a.id)).map((r) => r.runNumber)).toEqual([2, 1]);
    expect((await api.automationsList()).lastRuns.map((r) => r.runNumber)).toEqual([2]);
    await expect(api.automationRunNow("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("updates a run from the UI's reports", async () => {
    const api = createMockApi({});
    const a = await api.automationCreate(input());
    const run = await api.automationRunNow(a.id);
    await api.automationDispatchResult({ status: "dispatched", runId: run.id, tabId: "t1" });
    expect((await api.automationRuns(a.id))[0]).toMatchObject({ status: "dispatched", tabId: "t1" });
    await api.automationRunFinish({ runId: run.id, completed: true, output: "done", truncated: false });
    expect((await api.automationRuns(a.id))[0]).toMatchObject({ status: "completed", outputSnapshot: { content: "done", truncated: false } });
    const second = await api.automationRunNow(a.id);
    await api.automationDispatchResult({ status: "failed", runId: second.id, code: "needsApproval", detail: null });
    expect((await api.automationRuns(a.id))[0]).toMatchObject({ status: "skipped_needs_interactive_auth", errorCode: "needsApproval" });
    const third = await api.automationRunNow(a.id);
    await api.automationRunFinish({ runId: third.id, completed: false, output: null, truncated: false });
    expect((await api.automationRuns(a.id))[0]).toMatchObject({ status: "dispatch_failed", errorCode: "agentNoCompletion" });
    expect(api.__automationReports().results).toHaveLength(2);
    expect(api.__automationReports().finishes).toHaveLength(2);
  });

  it("emits changed for every write, until unlistened", async () => {
    const api = createMockApi({});
    const seen = vi.fn();
    const off = await api.onAutomationsChanged(seen);
    const a = await api.automationCreate(input());
    await api.automationSetEnabled(a.id, false);
    await api.automationRunNow(a.id);
    await api.automationDelete(a.id);
    expect(seen).toHaveBeenCalledTimes(4);
    expect(seen).toHaveBeenCalledWith({ automationId: a.id });
    off();
    await api.automationCreate(input());
    expect(seen).toHaveBeenCalledTimes(4);
  });

  it("plays the backend's dispatch event to the UI", async () => {
    const api = createMockApi({});
    const got = vi.fn();
    await api.onAutomationDispatch(got);
    const e = { runId: "r", automationId: "a", worktree: "/w", repoId: "r1", created: false, setup: "inherit" as const, profile: "claude", prompt: "p", extraArgs: [], reuseTab: null };
    api.__automationDispatch(e);
    expect(got).toHaveBeenCalledWith(e);
    expect(api.__automationReady()).toBe(0);
    await api.automationUiReady();
    expect(api.__automationReady()).toBe(1);
  });

  it("describes the presets and checks the schedule it is given", async () => {
    const api = createMockApi({});
    expect(await api.automationDescribe("FREQ=HOURLY;BYMINUTE=15", "UTC")).toEqual({ kind: "hourly", minute: 15 });
    expect(mockDescribe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0")).toEqual({ kind: "weekdays", hour: 9, minute: 0 });
    expect(mockDescribe("FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0")).toEqual({ kind: "weekly", hour: 14, minute: 0, dayOfWeek: 4 });
    expect(mockDescribe("0 9 * * 1-5")).toEqual({ kind: "weekdays", hour: 9, minute: 0 });
    expect(mockDescribe("0 9 1 * 1")).toEqual({ kind: "custom", expression: "0 9 1 * 1" });
    expect(mockDescribe("nonsense")).toEqual({ kind: "invalid" });
    expect(await api.automationValidateSchedule("0 9 * * *", "UTC")).toBeNull();
    expect(await api.automationValidateSchedule("0 9", "UTC")).toBe("invalid");
    expect(await api.automationNextRuns("0 9 * * *", "UTC", NOW, 9)).toHaveLength(5);
  });

  it("adds a run for a test and rejects an unknown automation", async () => {
    const api = createMockApi({});
    const a = await api.automationCreate(input());
    const run = api.__automationAddRun({ automationId: a.id, status: "completed", occurrenceCount: 3 });
    expect(run).toMatchObject({ status: "completed", occurrenceCount: 3, runNumber: 1 });
    expect(() => api.__automationAddRun({ automationId: "nope" })).toThrow();
  });
});
