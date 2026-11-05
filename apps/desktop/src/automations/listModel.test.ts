import { describe, expect, it } from "vitest";
import type { Automation, AutomationRun, RunStatus } from "@/api";
import { translate } from "@/i18n";
import { NO_QUERY, SEARCH_MAX, bucketOf, lastRunCell, nextSort, sortLabel, visibleRows, type ListQuery } from "./listModel";

const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const NOW = 1_793_793_600_000;

function auto(id: string, over: Partial<Automation> = {}): Automation {
  return {
    id, name: id, prompt: "do it", precheck: null, agent: "claude", extraAgentArgs: null, repoId: "r1", workspaceMode: "existing", worktree: "/w", baseBranch: null,
    setupDecision: "inherit", reuseSession: false, timezone: "UTC", rrule: "FREQ=DAILY", dtstart: 0, enabled: true, nextRunAt: NOW, lastRunAt: null,
    missedRunGraceMinutes: 720, createdAt: 0, updatedAt: 0, ...over,
  };
}

function run(automationId: string, status: RunStatus, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: `run-${automationId}`, automationId, title: "t", runNumber: 1, scheduledFor: NOW, status, trigger: "scheduled", worktree: null, worktreeName: null, tabId: null,
    outputSnapshot: null, precheckResult: null, error: null, errorCode: null, errorParams: null, startedAt: null, dispatchedAt: null, finishedAt: null,
    createdAt: NOW, occurrenceCount: 1, lastOccurrenceAt: null, ...over,
  };
}

const q = (over: Partial<ListQuery>): ListQuery => ({ ...NO_QUERY, ...over });
const names = (v: ReturnType<typeof visibleRows>) => v.rows.map((r) => r.automation.id);
const project = (id: string) => (id === "r1" ? "Alpha repo" : "Beta repo");

describe("visibleRows", () => {
  const automations = [auto("audit", { prompt: "check deps" }), auto("review", { repoId: "r2", agent: "codex" }), auto("clean", { name: "Cleanup" })];
  const runs = [run("audit", "completed"), run("review", "dispatch_failed")];

  it("searches name, prompt and project, ignoring case", () => {
    expect(names(visibleRows(automations, runs, project, q({ search: "AUDIT" })))).toEqual(["audit"]);
    expect(names(visibleRows(automations, runs, project, q({ search: "deps" })))).toEqual(["audit"]);
    expect(names(visibleRows(automations, runs, project, q({ search: "beta" })))).toEqual(["review"]);
    expect(visibleRows(automations, runs, project, q({ search: "zzz" })).filtered).toBe(true);
  });

  it("ignores a search that is too long", () => {
    const v = visibleRows(automations, runs, project, q({ search: "x".repeat(SEARCH_MAX + 1) }));
    expect(names(v)).toEqual(["audit", "review", "clean"]);
    expect(v.tooLong).toBe(true);
    expect(v.filtered).toBe(false);
    expect(visibleRows(automations, runs, project, q({ search: "x".repeat(SEARCH_MAX) })).tooLong).toBe(false);
  });

  it("filters by agent and by last run", () => {
    expect(names(visibleRows(automations, runs, project, q({ agent: "codex" })))).toEqual(["review"]);
    expect(names(visibleRows(automations, runs, project, q({ lastRun: "succeeded" })))).toEqual(["audit"]);
    expect(names(visibleRows(automations, runs, project, q({ lastRun: "failed" })))).toEqual(["review"]);
    expect(names(visibleRows(automations, runs, project, q({ lastRun: "never" })))).toEqual(["clean"]);
    expect(visibleRows(automations, runs, project, q({ lastRun: "failed" })).filtersOn).toBe(true);
  });

  it("keeps skipped and running runs out of succeeded and failed", () => {
    const more = [run("audit", "skipped_missed"), run("review", "dispatching")];
    for (const lastRun of ["succeeded", "failed"] as const) expect(names(visibleRows(automations, more, project, q({ lastRun })))).toEqual([]);
    expect(names(visibleRows(automations, more, project, q({ lastRun: "never" })))).toEqual(["clean"]);
  });

  it("sorts by name and by last run", () => {
    expect(names(visibleRows(automations, runs, project, q({ sort: { key: "name", dir: "asc" } })))).toEqual(["audit", "clean", "review"]);
    expect(names(visibleRows(automations, runs, project, q({ sort: { key: "name", dir: "desc" } })))[0]).toBe("review");
    const dated = [run("audit", "completed", { createdAt: NOW - 1000 }), run("review", "completed", { createdAt: NOW })];
    expect(names(visibleRows(automations, dated, project, q({ sort: { key: "lastRun", dir: "desc" } })))).toEqual(["review", "audit", "clean"]);
    expect(names(visibleRows(automations, dated, project, q({ sort: { key: "lastRun", dir: "asc" } })))).toEqual(["clean", "audit", "review"]);
  });
});

describe("sorting controls", () => {
  it("cycles ascending, descending, off", () => {
    const first = nextSort(null, "name");
    expect(first).toEqual({ key: "name", dir: "asc" });
    const second = nextSort(first, "name");
    expect(second).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(second, "name")).toBeNull();
    expect(nextSort(second, "lastRun")).toEqual({ key: "lastRun", dir: "asc" });
  });

  it("labels the sorted column", () => {
    expect(sortLabel({ key: "name", dir: "asc" }, "name", "Name", t)).toBe("Name, sorted ascending");
    expect(sortLabel({ key: "name", dir: "desc" }, "name", "Name", t)).toBe("Name, sorted descending");
    expect(sortLabel({ key: "name", dir: "asc" }, "lastRun", "Last run", t)).toBeNull();
    expect(sortLabel(null, "name", "Name", t)).toBeNull();
  });
});

describe("lastRunCell", () => {
  it("reads Never, Done and Failed with the age", () => {
    expect(lastRunCell(null, NOW, t)).toEqual({ tone: "idle", text: "Never" });
    expect(lastRunCell(run("a", "completed", { finishedAt: NOW - 5 * 60_000 }), NOW, t)).toEqual({ tone: "done", text: "Done 5 min" });
    expect(lastRunCell(run("a", "dispatch_failed", { finishedAt: NOW - 2 * 3_600_000 }), NOW, t)).toEqual({ tone: "failed", text: "Failed 2 h" });
    expect(lastRunCell(run("a", "skipped_missed", { createdAt: NOW - 3 * 3_600_000 }), NOW, t).text).toBe("Skipped 3 h");
    expect(lastRunCell(run("a", "dispatching"), NOW, t).tone).toBe("working");
  });

  it("buckets every status", () => {
    expect(bucketOf(null)).toBe("never");
    expect(bucketOf(run("a", "skipped_precheck"))).toBe("skipped");
    expect(bucketOf(run("a", "skipped_needs_interactive_auth"))).toBe("skipped");
  });
});
