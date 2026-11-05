import type { JSX } from "react";
import { Breadcrumb, Button, StatusDot } from "@xdev-asia/ui";
import type { Automation, AutomationRun } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { breadcrumbWorkspace, errorText, formatDate, runContent, statusLabel, statusTone } from "./runModel";

/** One run: where it ran, how it ended, and what it printed. */
export function AutomationRunDetails(props: {
  run: AutomationRun;
  /** The automation the run belongs to; null once it was deleted. */
  automation: Automation | null;
  exists(path: string): boolean;
  now: number;
  onBack(): void;
  onRerun(): void;
  onOpenWorkspace(path: string): void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const { run } = props;
  const tone = statusTone(run.status);
  const content = runContent(run, t);
  const failure = run.status === "dispatch_failed" ? errorText(run, t) : null;
  const worktree = run.worktree !== null && props.exists(run.worktree) ? run.worktree : null;
  return (
    <article className="au-run" aria-label={run.title}>
      <button type="button" className="au-link au-back" data-act="back" onClick={props.onBack}>
        {t("automations.runs.details.back")}
      </button>
      <header className="au-run-head">
        <h2 className="au-detail-title">{run.title}</h2>
        <div className="au-run-actions">
          {worktree && (
            <Button variant="secondary" data-act="open-workspace" onClick={() => props.onOpenWorkspace(worktree)}>
              {t("automations.runs.details.openWorkspace")}
            </Button>
          )}
          <Button variant="secondary" data-act="rerun" disabled={props.automation === null} onClick={props.onRerun}>
            {t("automations.runs.details.rerun")}
          </Button>
        </div>
      </header>
      <Breadcrumb
        items={[
          { label: t("automations.runs.details.scheduled", { date: formatDate(run.scheduledFor, locale), relative: ago(run.scheduledFor, props.now, t) }) },
          { label: t("app.name") },
          { label: breadcrumbWorkspace(run, t), mono: run.worktree !== null },
        ]}
      />
      <p className="au-run-status">
        <StatusDot state={tone} pulse={tone === "working"} label={statusLabel(run.status, t)} />
      </p>
      {failure && (
        <p className="au-error" role="alert" data-act="error">
          <strong>{t("automations.runs.details.error")}</strong> {failure}
        </p>
      )}
      {run.outputSnapshot?.truncated && content.kind === "output" && <p className="au-note">{t("automations.runs.details.truncated")}</p>}
      <pre className="au-output" data-kind={content.kind} aria-label={t("automations.runs.details.output")}>
        {content.text}
      </pre>
    </article>
  );
}
