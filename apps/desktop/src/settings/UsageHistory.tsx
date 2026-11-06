import { Badge, Button } from "@xdev-asia/ui";
import { useContext, useEffect, useState } from "react";
import type { JSX } from "react";
import type { DayTotals } from "@xdev/bindings";
import { toApiError, type Api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { UsageChart } from "@/kit/UsageChart";
import { formatCount, localDay } from "@/kit/kitUi";
import { LicenseUpsellContext } from "@/license/ProGate";

export type HistoryApi = Pick<Api, "usageArchive">;

/** The first day asked for: before any log, so the whole archive comes back. */
export const HISTORY_FROM = "2000-01-01";
export const HISTORY_FEATURE = "pro.usage_history";

/** One row per day, with a header; fields are numbers or a `YYYY-MM-DD` day, so nothing needs quoting. */
export function csvOf(days: DayTotals[]): string {
  const rows = days.map((d) => [d.day, d.input, d.output, d.cacheRead, d.cacheWrite].join(","));
  return ["day,input,output,cache_read,cache_write", ...rows].join("\n") + "\n";
}

/** The archive as the chart takes it. */
export function chartDays(days: DayTotals[]): [string, { input: number; output: number; cache_read: number; cache_write: number }][] {
  return days.map((d) => [d.day, { input: d.input, output: d.output, cache_read: d.cacheRead, cache_write: d.cacheWrite }]);
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** What a free device sees in place of the history: a button that names it and opens the upsell. */
export function UsageHistoryLocked(): JSX.Element {
  const { t } = useI18n();
  const upsell = useContext(LicenseUpsellContext);
  return (
    <div className="settings-actions settings-actions-start" data-field="usage-history-locked">
      <Button type="button" variant="secondary" data-act="usage-history" onClick={() => upsell(HISTORY_FEATURE)}>
        {t("usage.history.title")} <Badge>{t("pro.tag")}</Badge>
      </Button>
      <small className="settings-hint">{t("usage.history.locked")}</small>
    </div>
  );
}

/** The saved days past the logs the CLIs keep, as a chart with a CSV export. Only shown with Pro. */
export function UsageHistory({ api }: { api: HistoryApi }): JSX.Element {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<DayTotals[]>();
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    let live = true;
    api.usageArchive(HISTORY_FROM, localDay(new Date())).then(
      (d) => live && setDays(d),
      (e: unknown) => live && setError(toApiError(e).code),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const total = (days ?? []).reduce((n, d) => n + d.input + d.output + d.cacheRead + d.cacheWrite, 0);
  return (
    <section className="kit-block" aria-label={t("usage.history.title")} data-field="usage-history">
      <h3 className="kit-h">{t("usage.history.title")}</h3>
      <p className="settings-hint">{t("usage.history.hint")}</p>
      {error && (
        <p className="settings-hint" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {days !== undefined && days.length === 0 && <p className="kit-empty">{t("usage.history.empty")}</p>}
      {days !== undefined && days.length > 0 && (
        <>
          <p className="settings-hint" role="status">
            {t("usage.history.summary", { days: days.length, tokens: formatCount(total, locale) })}
          </p>
          <UsageChart days={chartDays(days)} />
          <div className="settings-actions settings-actions-start">
            <Button type="button" variant="secondary" data-act="usage-export" onClick={() => download("xdev-usage.csv", csvOf(days))}>
              {t("usage.history.export")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
