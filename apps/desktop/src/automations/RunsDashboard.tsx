import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { EmptyState, Icon, Segmented, StatTile, StatusDot } from "@xdev-asia/ui";
import type { Api, RunRow, RunsRange, RunsSummary } from "@/api";
import { useI18n } from "@/i18n";
import { formatCount } from "@/kit/kitUi";
import {
  DEFAULT_SORT,
  RANGES,
  UNKNOWN,
  costText,
  durationText,
  nextSort,
  sortRows,
  successRate,
  tokensText,
  totalCostText,
  totalTokensText,
  type DashSort,
  type DashSortKey,
} from "./dashboardModel";
import { formatDate, statusLabel, statusTone } from "./runModel";

/** The Runs view: every run in a time range with its tokens and cost when known, a summary row and a sortable table. */
export function RunsDashboard(props: {
  api: Api;
  /** Changes when the page asks for a reload. */
  reloadKey: number;
  /** Opens the run's details page. */
  onOpen(row: RunRow): void;
}): JSX.Element {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { api } = props;
  const [range, setRange] = useState<RunsRange>("7d");
  const [sort, setSort] = useState<DashSort>(DEFAULT_SORT);
  const [data, setData] = useState<RunsSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void api
      .automationRunsSummary(range)
      .then((s) => alive && setData(s))
      .catch(() => alive && (setFailed(true), setData(null)));
    return () => {
      alive = false;
    };
  }, [api, range, props.reloadKey]);

  const rows = useMemo(() => sortRows(data?.runs ?? [], sort), [data, sort]);
  const compact = (n: number) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);

  const rangeBar = (
    <Segmented
      label={t("automations.dash.range.label")}
      value={range}
      options={RANGES.map((r) => ({ value: r, label: t(`automations.dash.range.${r}`) }))}
      onChange={(value) => setRange(value as RunsRange)}
    />
  );

  let body: JSX.Element;
  if (failed) body = <p className="au-empty" role="alert">{t("automations.dash.error")}</p>;
  else if (data === null) body = <p className="au-empty" role="status" />;
  else if (data.runs.length === 0) body = <EmptyState title={t("automations.dash.empty")} hint={t("automations.dash.empty.hint")} />;
  else {
    const totals = data.totals;
    const rate = successRate(totals);
    const header = (key: DashSortKey, column: string) => {
      const dir = sort.key === key ? sort.dir : null;
      return (
        <th scope="col" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}>
          <button type="button" className="au-sort" data-act={`sort-${key}`} aria-label={t("automations.dash.sortBy", { column })} onClick={() => setSort(nextSort(sort, key))}>
            {column}
            {dir && <> <Icon name={dir === "asc" ? "arrow-up" : "arrow-down"} size={12} /></>}
          </button>
        </th>
      );
    };
    body = (
      <>
        <div className="au-stats" data-act="stats">
          <StatTile label={t("automations.dash.stat.runs")} value={formatCount(totals.runs, locale)} />
          <StatTile label={t("automations.dash.stat.rate")} value={rate === null ? UNKNOWN : `${rate}%`} />
          <StatTile label={t("automations.dash.stat.tokens")} value={totalTokensText(totals, compact)} hint={t("automations.dash.stat.coverage", { count: totals.withUsage, total: totals.runs })} />
          <StatTile label={t("automations.dash.stat.cost")} value={totalCostText(totals)} hint={t("automations.dash.stat.coverage", { count: totals.withUsage, total: totals.runs })} />
        </div>
        <table className="au-table au-dash" aria-label={t("automations.dash.table.label")}>
          <thead>
            <tr>
              <th scope="col">{t("automations.dash.col.automation")}</th>
              {header("started", t("automations.dash.col.started"))}
              <th scope="col">{t("automations.dash.col.duration")}</th>
              <th scope="col">{t("automations.dash.col.status")}</th>
              <th scope="col">{t("automations.dash.col.tokens")}</th>
              {header("cost", t("automations.dash.col.cost"))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.runId} className="au-row" data-act="run" data-run={row.runId} onClick={() => props.onOpen(row)}>
                <td data-label={t("automations.dash.col.automation")}>
                  <button type="button" className="au-link" data-act="open-run" onClick={(e) => (e.stopPropagation(), props.onOpen(row))}>
                    {row.automationName}
                  </button>
                </td>
                <td data-label={t("automations.dash.col.started")}>{row.startedAt === null ? UNKNOWN : formatDate(row.startedAt, locale)}</td>
                <td data-label={t("automations.dash.col.duration")}>{durationText(row.durationMs)}</td>
                <td data-label={t("automations.dash.col.status")}>
                  <StatusDot state={statusTone(row.status)} pulse={statusTone(row.status) === "working"} label={statusLabel(row.status, t)} />
                </td>
                <td data-label={t("automations.dash.col.tokens")}>{tokensText(row, compact)}</td>
                <td data-label={t("automations.dash.col.cost")}>{costText(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <section className="au-dashboard" aria-label={t("automations.dash.label")}>
      <div className="au-dash-bar">{rangeBar}</div>
      {body}
    </section>
  );
}
