import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { REPORT_THROTTLE_MS, cliStatus, startCliReport, tabReports } from "./cliReport";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";

describe("CLI tab report", () => {
  let sessions: Sessions | null = null;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
    vi.useRealTimers();
  });

  it("reports once at start, then two quick changes in one call with both", async () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    const reporter = startCliReport(api, s, () => A);
    expect(api.__cliReports()).toEqual([{ tabs: [], selected: A }]);
    const a = s.open(A, "shell");
    const b = s.open(A, "claude");
    await vi.advanceTimersByTimeAsync(REPORT_THROTTLE_MS - 1);
    expect(api.__cliReports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const reports = api.__cliReports();
    expect(reports).toHaveLength(2);
    expect(reports[1].tabs.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(reports[1].tabs[1]).toMatchObject({ worktree: A, profile: "claude", agent: true, exited: false });
    reporter.stop();
  });

  it("does not send an unchanged report again, and stops", async () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    let selected: string | null = null;
    const reporter = startCliReport(api, s, () => selected);
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.__cliReports()).toHaveLength(1);
    selected = A;
    reporter.poke();
    await vi.advanceTimersByTimeAsync(REPORT_THROTTLE_MS);
    expect(api.__cliReports().at(-1)?.selected).toBe(A);
    reporter.stop();
    s.open(A, "shell");
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.__cliReports()).toHaveLength(2);
  });

  it("maps a failed turn to done and an exited tab to idle", () => {
    expect(cliStatus({ status: "failed" })).toBe("done");
    expect(cliStatus({ status: "exited" })).toBe("idle");
    expect(cliStatus({ status: "needs-you" })).toBe("needs-you");
    expect(cliStatus({ status: "working" })).toBe("working");
  });

  it("reads each tab's row from the store", () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    const tab = s.open(A, "shell");
    expect(tabReports(s)).toEqual([{ id: tab.id, worktree: A, title: null, profile: "shell", agent: false, status: "idle", lastOutputMs: 0, exited: false }]);
    expect(s.lastOutput("nope")).toBeNull();
  });

  it("an agent tab carries its provider and account, which the failover sweep reads", () => {
    const api = createMockApi({});
    const s = (sessions = new Sessions(api));
    const tab = s.open(A, "claude", "claude-2", "claude");
    const [row] = tabReports(s).filter((r) => r.id === tab.id);
    expect(row).toMatchObject({ id: tab.id, profile: "claude", cli: "claude", account: "claude-2", exited: false });
    expect(row).not.toHaveProperty("exitCode");
  });
});
