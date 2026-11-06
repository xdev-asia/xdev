import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, Chart } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { onChartsOpen } from "./chartEvents";
import { seatLabel } from "./chartModel";
import { ChartsDialog } from "./ChartsDialog";
import { runChart, type ChartRunHost, type ChartRunOutcome } from "./runChart";

export interface ChartsHostProps {
  api: Api;
  /** Where a run's tabs open; null while the workspace has no sessions. */
  host: ChartRunHost | null;
}

/** The words for a run that did not start; null when it did. */
export function runProblem(outcome: ChartRunOutcome, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "no_worktree":
      return t("charts.run.noWorktree");
    case "agent_unusable":
      return t("charts.run.agentUnusable", { agent: outcome.agent });
    case "failed":
      return outcome.detail ? t("charts.failedWith", { detail: outcome.detail }) : t("charts.failed");
  }
}

/** Opens team charts when the palette, Mission Control or a squad asks, and runs a chart in the worktree in front. */
export function ChartsHost({ api, host }: ChartsHostProps): JSX.Element | null {
  const { t } = useI18n();
  const [open, setOpen] = useState<{ draft: Chart | null; key: number } | null>(null);

  useEffect(() => onChartsOpen((o) => setOpen((prev) => ({ draft: o.draft, key: (prev?.key ?? 0) + 1 }))), []);

  async function run(chart: Chart): Promise<string | null> {
    if (!host) return t("charts.run.noWorktree");
    const outcome = await runChart(api, host, chart, (seat, i) => seatLabel(seat, i, t));
    const why = runProblem(outcome, t);
    if (why === null) {
      setOpen(null);
      pushToast({ text: t("charts.started", { name: chart.name, n: chart.seats.length }) });
    }
    return why;
  }

  if (!open) return null;
  return <ChartsDialog key={open.key} api={api} draft={open.draft} onClose={() => setOpen(null)} onRun={run} />;
}
