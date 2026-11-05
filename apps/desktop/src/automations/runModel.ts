import type { AutomationRun, RunStatus } from "@/api";
import type { I18n, Locale } from "@/i18n";

type T = I18n["t"];

/** A `StatusDot` state: the dot a run status is drawn with. */
export type RunTone = "working" | "done" | "failed" | "waiting" | "idle";

export function isFinalStatus(status: RunStatus): boolean {
  return status !== "pending" && status !== "dispatching" && status !== "dispatched";
}

export function statusTone(status: RunStatus): RunTone {
  switch (status) {
    case "pending":
    case "dispatching":
    case "dispatched":
      return "working";
    case "completed":
      return "done";
    case "dispatch_failed":
      return "failed";
    case "skipped_needs_interactive_auth":
      return "waiting";
    default:
      return "idle";
  }
}

export function statusLabel(status: RunStatus, t: T): string {
  return t(`automations.runs.status.${status}`);
}

/** The failure text: translated by code with the stored values, else what was stored; null when the run has none. */
export function errorText(run: AutomationRun, t: T): string | null {
  if (run.errorCode) {
    const key = `automations.runFailures.${run.errorCode}`;
    const text = t(key, { ...(run.errorParams ?? {}) });
    if (text !== key) return text;
  }
  return run.error;
}

export type RunContent = { kind: "output" | "precheck" | "error" | "none"; text: string };

/** What the details page shows as the body: the output, else the precheck output, else the error, else a note. */
export function runContent(run: AutomationRun, t: T): RunContent {
  const snapshot = run.outputSnapshot?.content;
  if (snapshot && snapshot.trim()) return { kind: "output", text: snapshot };
  const pre = run.precheckResult;
  const precheck = pre ? [pre.stderr, pre.stdout].filter((s) => s.trim()).join("\n") : "";
  if (precheck) return { kind: "precheck", text: precheck };
  const error = errorText(run, t);
  if (error) return { kind: "error", text: error };
  return { kind: "none", text: t("automations.runs.details.noOutput") };
}

const basename = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** The workspace cell: its name, `Not launched` when the run never got one, or a note when it is gone. */
export function workspaceText(run: AutomationRun, exists: (path: string) => boolean, t: T): string {
  if (!run.worktree) return t("automations.runs.notLaunched");
  const name = run.worktreeName ?? basename(run.worktree);
  return exists(run.worktree) ? name : t("automations.runs.workspaceGone", { name });
}

/** The breadcrumb's workspace: its name, or `No workspace`. */
export function breadcrumbWorkspace(run: AutomationRun, t: T): string {
  return run.worktree ? (run.worktreeName ?? basename(run.worktree)) : t("automations.runs.noWorkspace");
}

export function formatDate(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

/** "3 times, most recently Nov 4, 2026, 12:00 PM" for a run that folded repeated skips; null for a single one. */
export function occurrenceText(run: AutomationRun, i18n: Pick<I18n, "t" | "locale">): string | null {
  if (run.occurrenceCount <= 1) return null;
  const at = run.lastOccurrenceAt ?? run.scheduledFor;
  return i18n.t("automations.runs.folded", { count: run.occurrenceCount, date: formatDate(at, i18n.locale) });
}

/** "12 runs · 9 completed". */
export function summaryText(runs: readonly AutomationRun[], t: T): string {
  const completed = runs.filter((r) => r.status === "completed").length;
  return t("automations.runs.summary", { count: runs.length, completed });
}
