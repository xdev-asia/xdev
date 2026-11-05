import type { JSX } from "react";
import { StatusDot } from "@xdev-asia/ui";
import type { AutomationRun } from "@/api";
import { useI18n } from "@/i18n";
import { occurrenceText, statusLabel, statusTone, summaryText, workspaceText } from "./runModel";

/** The runs of one automation, newest first: Run, Status, Workspace; a skipped run that repeated says how often. */
export function AutomationRunHistory(props: {
  runs: readonly AutomationRun[];
  /** Whether a worktree path still exists. */
  exists(path: string): boolean;
  onOpen(run: AutomationRun): void;
}): JSX.Element {
  const i18n = useI18n();
  const { t } = i18n;
  if (props.runs.length === 0) return <p className="au-empty">{t("automations.runs.empty")}</p>;
  return (
    <section className="au-history" aria-label={t("automations.runs.title")}>
      <p className="au-summary">{summaryText(props.runs, t)}</p>
      <table className="au-table au-runs">
        <thead>
          <tr>
            <th scope="col">{t("automations.runs.col.run")}</th>
            <th scope="col">{t("automations.runs.col.status")}</th>
            <th scope="col">{t("automations.runs.col.workspace")}</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((run) => {
            const folded = occurrenceText(run, i18n);
            return (
              <tr key={run.id} className="au-row" data-act="run" data-run={run.id}>
                <td>
                  <button type="button" className="au-link" data-act="open-run" onClick={() => props.onOpen(run)}>
                    {run.title}
                  </button>
                  {folded && <span className="au-sub">{folded}</span>}
                </td>
                <td>
                  <StatusDot state={statusTone(run.status)} pulse={statusTone(run.status) === "working"} label={statusLabel(run.status, t)} />
                </td>
                <td>{workspaceText(run, props.exists, t)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
