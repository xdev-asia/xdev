import { describe, expect, it } from "vitest";
import type { AutomationRun, RunStatus } from "@/api";
import { translate } from "@/i18n";
import { breadcrumbWorkspace, errorText, isFinalStatus, occurrenceText, runContent, statusLabel, statusTone, summaryText, workspaceText } from "./runModel";

const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "r1", automationId: "a1", title: "Audit run 1", runNumber: 1, scheduledFor: 1_793_793_600_000, status: "completed", trigger: "scheduled",
    worktree: null, worktreeName: null, tabId: null, outputSnapshot: null, precheckResult: null, error: null, errorCode: null, errorParams: null,
    startedAt: null, dispatchedAt: null, finishedAt: null, createdAt: 1_793_793_600_000, occurrenceCount: 1, lastOccurrenceAt: null, ...over,
  };
}

const precheck = (stdout: string, stderr: string) => ({ command: "c", exitCode: 1, timedOut: false, durationMs: 5, stdout, stderr, stdoutTruncated: false, stderrTruncated: false, error: null, startedAt: 0, completedAt: 5 });

describe("status", () => {
  it("is final for everything but the first three", () => {
    const open: RunStatus[] = ["pending", "dispatching", "dispatched"];
    for (const s of open) expect(isFinalStatus(s), s).toBe(false);
    for (const s of ["completed", "skipped_precheck", "skipped_missed", "skipped_unavailable", "skipped_needs_interactive_auth", "dispatch_failed"] as RunStatus[]) expect(isFinalStatus(s), s).toBe(true);
  });

  it("is labelled and toned", () => {
    expect(statusLabel("pending", t)).toBe("Queued");
    expect(statusLabel("dispatching", t)).toBe("Starting");
    expect(statusLabel("dispatched", t)).toBe("Launched");
    expect(statusLabel("completed", t)).toBe("Done");
    expect(statusLabel("skipped_precheck", t)).toBe("Precheck skipped");
    expect(statusLabel("skipped_missed", t)).toBe("Skipped");
    expect(statusLabel("skipped_unavailable", t)).toBe("Unavailable");
    expect(statusLabel("skipped_needs_interactive_auth", t)).toBe("Needs credentials");
    expect(statusLabel("dispatch_failed", t)).toBe("Failed");
    expect(statusTone("completed")).toBe("done");
    expect(statusTone("dispatch_failed")).toBe("failed");
    expect(statusTone("dispatched")).toBe("working");
    expect(statusTone("skipped_missed")).toBe("idle");
    expect(statusTone("skipped_needs_interactive_auth")).toBe("waiting");
  });
});

describe("runContent", () => {
  it("prefers the output, then the precheck, then the error, then a note", () => {
    const snapshot = { content: "agent output", capturedAt: 1, truncated: false };
    const base = { outputSnapshot: snapshot, precheckResult: precheck("out", "err"), error: "boom" };
    expect(runContent(run(base), t)).toEqual({ kind: "output", text: "agent output" });
    expect(runContent(run({ ...base, outputSnapshot: null }), t)).toEqual({ kind: "precheck", text: "err\nout" });
    expect(runContent(run({ ...base, outputSnapshot: null, precheckResult: null }), t)).toEqual({ kind: "error", text: "boom" });
    expect(runContent(run(), t)).toEqual({ kind: "none", text: "No output content available." });
  });

  it("skips a blank snapshot and blank precheck output", () => {
    const blank = { content: "  \n", capturedAt: 1, truncated: false };
    expect(runContent(run({ outputSnapshot: blank, precheckResult: precheck("", " ") }), t).kind).toBe("none");
    expect(runContent(run({ precheckResult: precheck("only out", "") }), t)).toEqual({ kind: "precheck", text: "only out" });
  });
});

describe("errorText", () => {
  it("translates the code with its values", () => {
    expect(errorText(run({ errorCode: "precheckExit", errorParams: { code: "3" }, error: "x" }), t)).toBe("Precheck exited with code 3.");
    expect(errorText(run({ errorCode: "agentNeverStarted", error: "stored" }), t)).toBe("The agent did not start working in time.");
  });

  it("falls back to the stored text, or null", () => {
    expect(errorText(run({ errorCode: null, error: "stored" }), t)).toBe("stored");
    expect(errorText(run({ errorCode: "noSuchCode" as never, error: "stored" }), t)).toBe("stored");
    expect(errorText(run(), t)).toBeNull();
  });
});

describe("workspace", () => {
  it("says what the run got", () => {
    const here = () => true;
    const gone = () => false;
    expect(workspaceText(run(), here, t)).toBe("Not launched");
    expect(workspaceText(run({ worktree: "/w/auto-x", worktreeName: "auto-x" }), here, t)).toBe("auto-x");
    expect(workspaceText(run({ worktree: "/w/auto-x", worktreeName: "auto-x" }), gone, t)).toBe("auto-x (no longer available)");
    expect(workspaceText(run({ worktree: "C:\\w\\feature\\" }), here, t)).toBe("feature");
    expect(breadcrumbWorkspace(run(), t)).toBe("No workspace");
    expect(breadcrumbWorkspace(run({ worktree: "/w/a", worktreeName: "alpha" }), t)).toBe("alpha");
  });
});

describe("occurrences and summary", () => {
  it("folds repeated skips into one line", () => {
    expect(occurrenceText(run(), { t, locale: "en" })).toBeNull();
    const text = occurrenceText(run({ occurrenceCount: 3, lastOccurrenceAt: 1_793_793_600_000 }), { t, locale: "en" });
    expect(text).toMatch(/^3 times, most recently .*2026/);
  });

  it("counts runs and completed ones", () => {
    const runs = [run(), run({ status: "dispatch_failed" }), run({ status: "completed" })];
    expect(summaryText(runs, t)).toBe("3 runs · 2 completed");
    expect(summaryText([run()], t)).toBe("1 run · 1 completed");
    expect(summaryText([], t)).toBe("0 runs · 0 completed");
  });
});
