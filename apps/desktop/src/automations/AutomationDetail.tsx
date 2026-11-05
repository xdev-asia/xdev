import type { JSX } from "react";
import type { Automation, AutomationRun } from "@/api";
import { useI18n } from "@/i18n";
import { formatDate } from "./runModel";
import { graceLabel } from "./schedule";
import { AutomationRunHistory } from "./AutomationRunHistory";

/** The detail pane of the selected automation: its settings, then its runs. */
export function AutomationDetail(props: {
  automation: Automation;
  schedule: string;
  project: string;
  agentName: string;
  runs: readonly AutomationRun[];
  exists(path: string): boolean;
  onOpenRun(run: AutomationRun): void;
}): JSX.Element {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const a = props.automation;
  const last = props.runs[0] ?? null;
  const rows: [string, string][] = [
    [t("automations.detail.schedule"), props.schedule],
    [t("automations.detail.nextRun"), a.enabled ? formatDate(a.nextRunAt, locale) : t("automations.detail.nextRun.paused")],
    [t("automations.detail.lastRun"), last ? formatDate(last.createdAt, locale) : t("automations.list.lastRun.never")],
    [t("automations.detail.agent"), props.agentName],
    [t("automations.detail.precheck"), a.precheck ? t("automations.detail.precheck.on", { seconds: a.precheck.timeoutSeconds }) : t("automations.detail.precheck.none")],
    [t("automations.detail.grace"), graceLabel(a.missedRunGraceMinutes, t)],
    [t("automations.detail.session"), t(a.reuseSession ? "automations.detail.session.reuse" : "automations.detail.session.fresh")],
    [t("automations.detail.location"), t(a.workspaceMode === "existing" ? "automations.detail.location.existing" : "automations.detail.location.new")],
  ];
  if (a.workspaceMode === "new_per_run") rows.push([t("automations.detail.createFrom"), a.baseBranch ?? t("automations.detail.projectDefault")]);
  rows.push([t("automations.detail.extraArgs"), a.extraAgentArgs ?? t("automations.detail.none")]);
  return (
    <aside className="au-detail" aria-label={a.name}>
      <h2 className="au-detail-title">{a.name}</h2>
      <p className="au-sub">{props.project}</p>
      <dl className="au-facts">
        {rows.map(([k, v]) => (
          <div key={k} className="au-fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="au-detail-sub">{t("automations.runs.title")}</h3>
      <AutomationRunHistory runs={props.runs} exists={props.exists} onOpen={props.onOpenRun} />
    </aside>
  );
}
