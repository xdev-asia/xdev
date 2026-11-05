import type { ApiError, Automation, AutomationInput, ExtraArgsError, RepoView, ScheduleProblem, SetupDecision, WorkspaceMode } from "@/api";
import type { I18n } from "@/i18n";
import { DEFAULT_GRACE_MINUTES, DEFAULT_TIMEOUT_SECONDS, DEFAULT_DRAFT, presetOf, toRrule, type ScheduleDraft } from "./schedule";
import type { AutomationTemplate } from "./templates";

type T = I18n["t"];

/** What the editor dialog edits; every field is text or a choice, so the form can bind to it directly. */
export interface EditorDraft {
  name: string;
  prompt: string;
  repoId: string;
  mode: WorkspaceMode;
  /** A worktree path, for `existing`. */
  worktree: string;
  /** A branch name, for `new_per_run`; blank is the project default. */
  baseBranch: string;
  agent: string;
  reuseSession: boolean;
  schedule: ScheduleDraft;
  grace: number;
  precheckCommand: string;
  precheckTimeout: number;
  extraArgs: string;
  setup: SetupDecision;
}

export interface Agent {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
}

export function blankDraft(defaults: { repoId: string; agent: string }): EditorDraft {
  return {
    name: "",
    prompt: "",
    repoId: defaults.repoId,
    mode: "existing",
    worktree: "",
    baseBranch: "",
    agent: defaults.agent,
    reuseSession: false,
    schedule: { ...DEFAULT_DRAFT },
    grace: DEFAULT_GRACE_MINUTES,
    precheckCommand: "",
    precheckTimeout: DEFAULT_TIMEOUT_SECONDS,
    extraArgs: "",
    setup: "inherit",
  };
}

export function draftOf(a: Automation): EditorDraft {
  return {
    name: a.name,
    prompt: a.prompt,
    repoId: a.repoId,
    mode: a.workspaceMode,
    worktree: a.worktree ?? "",
    baseBranch: a.baseBranch ?? "",
    agent: a.agent,
    reuseSession: a.reuseSession,
    schedule: presetOf(a.rrule),
    grace: a.missedRunGraceMinutes,
    precheckCommand: a.precheck?.command ?? "",
    precheckTimeout: a.precheck?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    extraArgs: a.extraAgentArgs ?? "",
    setup: a.setupDecision,
  };
}

/** A template fills the name, the prompt, the schedule and the grace; the agent and the location stay. */
export function applyTemplate(draft: EditorDraft, template: AutomationTemplate, t: T): EditorDraft {
  return {
    ...draft,
    name: t(`automations.templates.${template.id}.name`),
    prompt: t(`automations.templates.${template.id}.prompt`),
    schedule: { ...template.schedule },
    grace: template.graceMinutes,
  };
}

/** Why the draft cannot be saved; the first problem found, in the order the form reads. */
export type Problem = "input" | "workspace" | "agent" | "schedule" | "extraArgs" | "freshSession";

export interface Context {
  repos: readonly RepoView[];
  agents: readonly Agent[];
  /** The error key `automationValidateSchedule` gave for the custom cron, or null when it is valid. */
  cronError: ScheduleProblem | null;
  /** The extra arguments were refused by the backend. */
  extraArgsError: ExtraArgsError | null;
}

export function problemOf(d: EditorDraft, ctx: Context): Problem | null {
  const repo = ctx.repos.find((r) => r.id === d.repoId);
  if (!d.prompt.trim() || !repo) return "input";
  if (d.mode === "existing" && !repo.worktrees.some((w) => w.path === d.worktree)) return "workspace";
  const agent = ctx.agents.find((a) => a.id === d.agent);
  if (!agent || !agent.enabled || !agent.installed) return "agent";
  if (d.schedule.preset === "custom" && (d.schedule.cron.trim() === "" || ctx.cronError !== null)) return "schedule";
  if (d.extraArgs.trim() !== "" && d.reuseSession && d.mode === "existing") return "freshSession";
  if (ctx.extraArgsError) return "extraArgs";
  return null;
}

/** `defaultName` is the name a blank one takes, in the person's language (`automations.defaultName`). */
export function buildInput(d: EditorDraft, opts: { timezone: string; dtstart: number; enabled: boolean; defaultName?: string }): AutomationInput {
  const command = d.precheckCommand.trim();
  const extra = d.extraArgs.trim();
  const existing = d.mode === "existing";
  return {
    name: d.name.trim() || (opts.defaultName ?? ""),
    prompt: d.prompt.trim(),
    precheck: command ? { command, timeoutSeconds: d.precheckTimeout } : null,
    agent: d.agent,
    extraAgentArgs: extra || null,
    repoId: d.repoId,
    workspaceMode: d.mode,
    worktree: existing ? d.worktree : null,
    baseBranch: existing ? null : d.baseBranch.trim() || null,
    setupDecision: d.setup,
    reuseSession: existing && d.reuseSession,
    timezone: opts.timezone,
    rrule: toRrule(d.schedule),
    dtstart: opts.dtstart,
    enabled: opts.enabled,
    missedRunGraceMinutes: d.grace,
  };
}

/** The extra-args refusal a failed save carries (`extra_args`, with the error as JSON in `detail`), or null. */
export function extraArgsErrorOf(e: unknown): ExtraArgsError | null {
  const err = e as Partial<ApiError> | null;
  if (!err || err.code !== "extra_args" || typeof err.detail !== "string") return null;
  try {
    const parsed = JSON.parse(err.detail) as { code?: unknown };
    return typeof parsed.code === "string" ? (parsed as ExtraArgsError) : null;
  } catch {
    return null;
  }
}

export function extraArgsMessage(e: ExtraArgsError, t: T): string {
  const { code, ...vars } = e;
  return t(`automations.extraArgs.errors.${code}`, vars as Record<string, string>);
}

export function problemMessage(p: Problem, t: T): string {
  switch (p) {
    case "input":
      return t("automations.editor.error.input");
    case "workspace":
      return t("automations.editor.error.workspace");
    case "agent":
      return t("automations.editor.error.agent");
    case "schedule":
      return t("automations.editor.error.schedule");
    case "extraArgs":
      return t("automations.editor.error.extraArgs");
    case "freshSession":
      return t("automations.editor.needsFreshSession");
  }
}

/** The live message under the custom cron: `Enter a five-field cron.`, the error, or `Valid custom cron`. */
export function cronMessage(cron: string, error: ScheduleProblem | null, t: T): { tone: "info" | "error"; text: string } {
  if (cron.trim() === "") return { tone: "info", text: t("automations.cron.empty") };
  if (error?.key === "step" && error.field && error.max !== null) {
    // The field's caption (Minute, Hour…) in the sentence's case.
    const field = t(`automations.cron.${error.field}`).toLocaleLowerCase();
    return { tone: "error", text: t("automations.cron.error.step", { field, max: error.max }) };
  }
  if (error !== null) return { tone: "error", text: t(`automations.cron.error.${error.key}`) };
  return { tone: "info", text: t("automations.cron.valid") };
}

/** The five fields of a cron, as typed, for the captions under the input; fewer than five leaves the rest empty. */
export function cronFields(cron: string): string[] {
  const parts = cron.split(/\s+/).filter(Boolean).slice(0, 5);
  return [...parts, ...Array.from({ length: 5 - parts.length }, () => "")];
}

/** The IANA zone of this computer. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
