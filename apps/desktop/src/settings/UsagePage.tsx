import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Agent, type ApiError, type UsageReport, type UsageScope, type UsageSettings } from "@/api";
import { useI18n } from "@/i18n";
import { displayPath, totalOf, type Tokens } from "@/kit/kitUi";
import { TokenTable } from "@/kit/UsageTab";
import { UsageChart } from "@/kit/UsageChart";
import { rangeDays, type UsageRange } from "@/kit/usageRange";
import type { SettingsSectionProps } from "./sections";
import { setUsageSettings } from "./usageSettings";

export type Provider = "overview" | Agent;
export const PROVIDERS: Provider[] = ["overview", "claude", "codex"];
export const SCOPES: UsageScope[] = ["xdev", "all"];
export const RANGES: UsageRange[] = ["7", "30", "90", "all"];
const AGENTS: Agent[] = ["claude", "codex"];

/** Settings → Stats & Usage: what the agents on this machine spent, from their local logs. */
export function UsagePage(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  // Session state only: none of these three is saved.
  const [provider, setProvider] = useState<Provider>("overview");
  const [scope, setScope] = useState<UsageScope>("xdev");
  const [range, setRange] = useState<UsageRange>("30");
  const [report, setReport] = useState<UsageReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const [reads, setReads] = useState(0);
  // The first read of the page reads the new log bytes; Refresh and Enable ask for it again.
  const refresh = useRef(true);

  useEffect(() => {
    api.usageSettings().then(setSettings, (e) => setError(toApiError(e).code));
  }, [api]);

  // Agents the chosen provider covers, and which of them may be read.
  const covered: Agent[] = provider === "overview" ? AGENTS : [provider];
  const off = settings === null ? [] : covered.filter((a) => !settings.scan[a]);
  const anyOn = settings !== null && off.length < covered.length;

  useEffect(() => {
    if (settings === null || !anyOn) {
      setReport(undefined);
      setBusy(false);
      return;
    }
    let stale = false;
    setBusy(true);
    const wanted = refresh.current;
    refresh.current = false;
    const { sinceDay, untilDay } = rangeDays(range, new Date());
    api.kitUsageReport({ sinceDay, untilDay, agent: provider === "overview" ? null : provider, scope, refresh: wanted }).then(
      (next) => {
        if (stale) return;
        setReport(next);
        setError(undefined);
        setBusy(false);
      },
      (e) => {
        if (stale) return;
        setError(toApiError(e).code);
        setBusy(false);
      },
    );
    return () => {
      stale = true;
    };
    // `reads` asks for another read of the same query; `settings` changes when a scan switch does.
  }, [api, settings, anyOn, provider, scope, range, reads]);

  async function enable(agent: Agent): Promise<void> {
    if (settings === null || busy) return;
    try {
      const stored = await api.usageSettingsPut({ ...settings, scan: { ...settings.scan, [agent]: true } });
      setUsageSettings(stored);
      refresh.current = true;
      setSettings(stored);
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  const label = (a: Agent) => t(`usage.stats.provider.${a}`);
  const tokens = report === undefined ? 0 : report.by_agent.reduce((n, [, tk]) => n + totalOf(tk), 0);
  const since = report?.tracking_since ? new Date(report.tracking_since).toLocaleDateString() : t("usage.stats.noDate");
  const days = report?.summary.days ?? [];
  const empty = report !== undefined && (days.length === 0 || tokens === 0);

  return (
    <div className="settings-page usage-page">
      <header className="settings-head">
        <h3>{t("settings.usage.title")}</h3>
        <p>{t("settings.usage.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <div className="usage-tiles">
        {(
          [
            ["sessions", String(report?.sessions ?? 0)],
            ["tokens", String(tokens)],
            ["since", since],
          ] as const
        ).map(([key, value]) => (
          <div className="usage-tile" key={key} data-tile={key}>
            <span className="usage-tile-label">{t(`usage.stats.tile.${key}`)}</span>
            <strong className="usage-tile-value">{value}</strong>
          </div>
        ))}
      </div>

      <div className="ws-fields usage-controls">
        <label className="ws-field">
          <span>{t("usage.stats.provider")}</span>
          <select value={provider} data-field="provider" onChange={(e) => setProvider(e.target.value as Provider)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {t(`usage.stats.provider.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          <span>{t("usage.stats.scope")}</span>
          <select value={scope} data-field="scope" onChange={(e) => setScope(e.target.value as UsageScope)}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {t(`usage.stats.scope.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          <span>{t("usage.stats.range")}</span>
          <select value={range} data-field="range" onChange={(e) => setRange(e.target.value as UsageRange)}>
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {t(`usage.stats.range.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="settings-actions settings-actions-start">
          <button
            type="button"
            className="btn-secondary"
            data-act="refresh"
            aria-busy={busy}
            disabled={busy || !anyOn}
            onClick={() => {
              if (busy) return;
              refresh.current = true;
              setReads((n) => n + 1);
            }}
          >
            {busy && <span className="usage-spinner" aria-hidden="true" />}
            {busy ? t("usage.stats.refreshing") : t("usage.stats.refresh")}
          </button>
        </div>
      </div>

      {off.map((a) => (
        <div className="usage-off" key={a} data-off={a}>
          <span>{t("usage.stats.off", { provider: label(a) })}</span>
          <button type="button" className="btn-secondary" data-act={`enable-${a}`} onClick={() => void enable(a)}>
            {t("usage.stats.enable", { provider: label(a) })}
          </button>
        </div>
      ))}

      {report !== undefined && empty && <p className="kit-empty">{t("usage.stats.empty")}</p>}
      {report !== undefined && !empty && (
        <div className="kit-usage">
          <div className="kit-legend" aria-hidden="true">
            {(["input", "output", "cache"] as const).map((part) => (
              <span key={part} className="kit-legend-item" data-series={part}>
                <span className={`kit-swatch kit-bar-${part}`} />
                {t(`kit.usage.${part}`)}
              </span>
            ))}
            <span className="kit-legend-total">{t("kit.tokens", { count: tokens })}</span>
          </div>
          <UsageChart days={days} />
          {provider === "overview" ? (
            <TokenTable title={t("usage.stats.byProvider")} rows={report.by_agent.map<[string, Tokens]>(([a, tk]) => [label(a), tk])} />
          ) : (
            <>
              <TokenTable title={t("kit.usage.byModel")} rows={report.summary.by_model} />
              <TokenTable title={t("kit.usage.byFolder")} rows={report.summary.by_folder.map<[string, Tokens]>(([f, tk]) => [displayPath(f), tk])} />
            </>
          )}
          <section className="kit-block" aria-label={t("kit.usage.top")}>
            <h3 className="kit-h">{t("kit.usage.top")}</h3>
            <table className="kit-table">
              <thead>
                <tr>
                  <th scope="col">{t("kit.usage.col.session")}</th>
                  <th scope="col">{t("kit.usage.byFolder")}</th>
                  <th scope="col">{t("kit.usage.byModel")}</th>
                  <th scope="col">{t("kit.usage.col.last")}</th>
                  <th scope="col" className="kit-num">{t("kit.usage.total")}</th>
                </tr>
              </thead>
              <tbody>
                {report.summary.top_sessions.map((s) => (
                  <tr key={`${s.home_id}/${s.id}`} data-session={s.id}>
                    <td className="kit-cut" title={s.id}>{`${label(s.agent)} · ${s.id.slice(0, 8)}`}</td>
                    <td className="kit-cut" title={s.folder === null ? "" : displayPath(s.folder)}>{s.folder === null ? t("kit.usage.noFolder") : displayPath(s.folder)}</td>
                    <td className="kit-cut">{s.model ?? t("kit.usage.noModel")}</td>
                    <td>{s.last > 0 ? new Date(s.last).toLocaleString() : "–"}</td>
                    <td className="kit-num">{totalOf(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}
