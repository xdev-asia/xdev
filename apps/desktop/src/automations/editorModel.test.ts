import { describe, expect, it } from "vitest";
import type { Automation, ExtraArgsError, RepoView } from "@/api";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { applyTemplate, blankDraft, buildInput, cronFields, cronMessage, draftOf, extraArgsErrorOf, extraArgsMessage, problemMessage, problemOf, type Agent, type Context } from "./editorModel";
import { templateById } from "./templates";

const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const repos: RepoView[] = DEMO_WORKSPACE.repos;
const repo = repos[0];
const wt = repo.worktrees[0].path;
const agents: Agent[] = [
  { id: "claude", name: "Claude", enabled: true, installed: true },
  { id: "off", name: "Off", enabled: false, installed: true },
  { id: "gone", name: "Gone", enabled: true, installed: false },
];
const ctx = (over: Partial<Context> = {}): Context => ({ repos, agents, cronError: null, extraArgsError: null, ...over });
const ready = () => ({ ...blankDraft({ repoId: repo.id, agent: "claude" }), prompt: "Audit", worktree: wt });

describe("problemOf", () => {
  it("accepts a complete draft", () => {
    expect(problemOf(ready(), ctx())).toBeNull();
  });

  it("asks for a prompt and a project first", () => {
    expect(problemOf({ ...ready(), prompt: "  " }, ctx())).toBe("input");
    expect(problemOf({ ...ready(), repoId: "" }, ctx())).toBe("input");
    expect(problemMessage("input", t)).toBe("Choose a run location and enter a prompt before saving.");
  });

  it("needs an available workspace for an existing run location only", () => {
    expect(problemOf({ ...ready(), worktree: "" }, ctx())).toBe("workspace");
    expect(problemOf({ ...ready(), worktree: "/gone" }, ctx())).toBe("workspace");
    expect(problemOf({ ...ready(), mode: "new_per_run", worktree: "" }, ctx())).toBeNull();
    expect(problemMessage("workspace", t)).toBe("Choose an available workspace before saving.");
  });

  it("needs an enabled, installed agent", () => {
    for (const agent of ["off", "gone", "nope", ""]) expect(problemOf({ ...ready(), agent }, ctx()), agent).toBe("agent");
    expect(problemMessage("agent", t)).toBe("Choose an enabled agent before saving.");
  });

  it("needs a valid custom cron", () => {
    const custom = { ...ready(), schedule: { ...ready().schedule, preset: "custom" as const, cron: "0 9 * * *" } };
    expect(problemOf(custom, ctx())).toBeNull();
    expect(problemOf(custom, ctx({ cronError: "invalid" }))).toBe("schedule");
    expect(problemOf({ ...custom, schedule: { ...custom.schedule, cron: " " } }, ctx())).toBe("schedule");
    expect(problemMessage("schedule", t)).toBe("Enter a valid advanced schedule before saving.");
  });

  it("refuses extra arguments with a reused session, and arguments the backend refused", () => {
    const extras = { ...ready(), extraArgs: "--model opus", reuseSession: true };
    expect(problemOf(extras, ctx())).toBe("freshSession");
    expect(problemOf({ ...extras, mode: "new_per_run" }, ctx())).toBeNull();
    expect(problemOf({ ...ready(), extraArgs: "--bad" }, ctx({ extraArgsError: { code: "terminator" } }))).toBe("extraArgs");
    expect(problemMessage("freshSession", t)).toBe("Extra arguments require a fresh session for every run.");
  });
});

describe("buildInput", () => {
  const opts = { timezone: "Asia/Ho_Chi_Minh", dtstart: 1_793_793_600_000, enabled: true };

  it("makes the create payload", () => {
    const input = buildInput({ ...ready(), name: " Audit " }, opts);
    expect(input).toEqual({
      name: "Audit", prompt: "Audit", precheck: null, agent: "claude", extraAgentArgs: null, repoId: repo.id, workspaceMode: "existing", worktree: wt, baseBranch: null,
      setupDecision: "inherit", reuseSession: false, timezone: "Asia/Ho_Chi_Minh", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
      dtstart: 1_793_793_600_000, enabled: true, missedRunGraceMinutes: 720,
    });
  });

  it("sends a precheck only when there is a command", () => {
    expect(buildInput({ ...ready(), precheckCommand: "  " }, opts).precheck).toBeNull();
    expect(buildInput({ ...ready(), precheckCommand: " gh pr list ", precheckTimeout: 120 }, opts).precheck).toEqual({ command: "gh pr list", timeoutSeconds: 120 });
  });

  it("drops what the run location does not use", () => {
    const fresh = buildInput({ ...ready(), mode: "new_per_run", baseBranch: " main ", reuseSession: true }, opts);
    expect(fresh).toMatchObject({ workspaceMode: "new_per_run", worktree: null, baseBranch: "main", reuseSession: false });
    expect(buildInput({ ...ready(), mode: "new_per_run", baseBranch: " " }, opts).baseBranch).toBeNull();
    expect(buildInput({ ...ready(), baseBranch: "main" }, opts).baseBranch).toBeNull();
  });

  it("sends the extra arguments trimmed, or null", () => {
    expect(buildInput({ ...ready(), extraArgs: " --model opus " }, opts).extraAgentArgs).toBe("--model opus");
    expect(buildInput({ ...ready(), extraArgs: " " }, opts).extraAgentArgs).toBeNull();
  });
});

describe("draftOf", () => {
  it("opens a saved automation and builds back to it", () => {
    const a: Automation = {
      id: "a1", name: "Nightly", prompt: "Look", precheck: { command: "ls", timeoutSeconds: 30 }, agent: "claude", extraAgentArgs: "--model opus", repoId: repo.id, workspaceMode: "new_per_run",
      worktree: null, baseBranch: "main", setupDecision: "skip", reuseSession: false, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=16;BYMINUTE=30", dtstart: 5, enabled: false,
      nextRunAt: 9, lastRunAt: null, missedRunGraceMinutes: 180, createdAt: 1, updatedAt: 2,
    };
    const input = buildInput(draftOf(a), { timezone: a.timezone, dtstart: a.dtstart, enabled: a.enabled });
    const { id: _id, nextRunAt: _n, lastRunAt: _l, createdAt: _c, updatedAt: _u, ...saved } = a;
    expect(input).toEqual(saved);
  });
});

describe("templates", () => {
  it("fill the name, prompt, schedule and grace and keep the rest", () => {
    const base = { ...ready(), agent: "claude", mode: "new_per_run" as const };
    const next = applyTemplate(base, templateById("maintenance-hourly")!, t);
    expect(next.name).toBe("Hourly maintenance check");
    expect(next.prompt).toContain("repository");
    expect(next.schedule).toMatchObject({ preset: "hourly", minute: 15 });
    expect(next.grace).toBe(30);
    expect(next).toMatchObject({ agent: "claude", mode: "new_per_run", repoId: repo.id });
  });
});

describe("messages", () => {
  it("reads the live cron message", () => {
    expect(cronMessage("", null, t)).toEqual({ tone: "info", text: "Enter a five-field cron." });
    expect(cronMessage("0 9 * * 1-5", null, t)).toEqual({ tone: "info", text: "Valid custom cron" });
    expect(cronMessage("0 9", "invalid", t)).toEqual({ tone: "error", text: "Enter a valid five-field cron before saving." });
  });

  it("splits a cron into five captions", () => {
    expect(cronFields("0 9 * * 1-5")).toEqual(["0", "9", "*", "*", "1-5"]);
    expect(cronFields("0 9")).toEqual(["0", "9", "", "", ""]);
    expect(cronFields("  1 2 3 4 5 6 ")).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("reads an extra-args refusal from a failed save", () => {
    const err: ExtraArgsError = { code: "optionNotAllowed", option: "--bad" };
    expect(extraArgsErrorOf({ code: "extra_args", detail: JSON.stringify(err) })).toEqual(err);
    expect(extraArgsErrorOf({ code: "extra_args", detail: "not json" })).toBeNull();
    expect(extraArgsErrorOf({ code: "io" })).toBeNull();
    expect(extraArgsMessage(err, t)).toBe("The option --bad is not allowed.");
    expect(extraArgsMessage({ code: "unsupported" }, t)).toBe("Extra arguments aren't supported for this agent yet.");
  });
});
