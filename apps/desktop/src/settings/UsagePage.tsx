import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Badge, Heatmap } from "@xdev-asia/ui";
import { toApiError, type Account, type Agent, type Quota, type ApiError, type UsageDisplay, type UsageReport, type UsageScope, type UsageSettings } from "@/api";
import { useI18n } from "@/i18n";
import { dayRange, displayPath, formatCount, localDay, totalOf, type Tokens } from "@/kit/kitUi";
import type { ShareCardData } from "@/kit/shareCard";
import { TokenTable } from "@/kit/UsageTab";
import { UsageChart } from "@/kit/UsageChart";
import { rangeDays, type UsageRange } from "@/kit/usageRange";
import { RECENT_DAYS, bestDay, cacheReuse, formatCost, recentDays } from "@/kit/usageStats";
import { UsageRecentSessions } from "./UsageRecentSessions";
import { UsageShare } from "./UsageShare";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS } from "./usageDefaults";
import type { SettingsSectionProps } from "./sections";
import { credentialRows } from "./usageCredentials";
import { getUsageSettings, setUsageSettings, useUsageSettings } from "./usageSettings";

export type Provider = "overview" | Agent;
export const PROVIDERS: Provider[] = ["overview", "claude", "codex"];
export const SCOPES: UsageScope[] = ["xdev", "all"];
export const RANGES: UsageRange[] = ["7", "30", "90", "all"];
const AGENTS: Agent[] = ["claude", "codex"];
export const DISPLAYS: UsageDisplay[] = ["used", "remaining"];
// Catalog ids of the page's settings, per group; a switch adds its provider (`usage.footer.claude`).
const FOOTER_IDS = ["usage.display", ...AGENTS.map((a) => `usage.footer.${a}`)];
const CACHE_IDS = ["usage.cacheTimer", "usage.cacheTtl"];
export const CACHE_TTLS = [CACHE_TTL_SHORT_MS, CACHE_TTL_LONG_MS] as const;
const SCAN_IDS = AGENTS.map((a) => `usage.scan.${a}`);
const CRED_IDS = ["usage.credentials"];

/** Settings → Stats & Usage: what the agents on this machine spent, from their local logs. */
export function UsagePage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t, locale } = useI18n();
  // The window's shared copy: a change made elsewhere shows here, and a save starts from it.
  const shared = useUsageSettings();
  const [loaded, setLoaded] = useState(false);
  const settings: UsageSettings | null = loaded ? shared : null;
  // Session state only: none of these three is saved.
  const [provider, setProvider] = useState<Provider>("overview");
  const [scope, setScope] = useState<UsageScope>("xdev");
  const [range, setRange] = useState<UsageRange>("30");
  const [report, setReport] = useState<UsageReport>();
  // The last six weeks by day, for the heatmap and the share card, whatever the range.
  const [recent, setRecent] = useState<[string, Tokens][]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const [reads, setReads] = useState(0);
  // Credentials: read once on open and once per Check again; never polled.
  const [accounts, setAccounts] = useState<Account[]>();
  const [quota, setQuota] = useState<Quota[]>([]);
  const [checking, setChecking] = useState(false);
  // The first read of the page reads the new log bytes; Refresh and Enable ask for it again.
  const refresh = useRef(true);
  const saving = useRef(false);

  useEffect(() => {
    api.usageSettings().then(
      (stored) => {
        setUsageSettings(stored);
        setLoaded(true);
      },
      (e) => setError(toApiError(e).code),
    );
  }, [api]);

  async function checkCredentials(): Promise<void> {
    setChecking(true);
    try {
      const [a, q] = await Promise.all([api.accounts(), api.quota()]);
      setAccounts(a.accounts);
      setQuota(q);
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void checkCredentials();
  }, [api]);
  async function signIn(name: string): Promise<void> {
    try {
      await api.loginAccount(name);
      // The sign-in is done; look once more, so the row does not stay on its old state.
      await checkCredentials();
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  // Agents the chosen provider covers, and which of them may be read.
  const covered: Agent[] = provider === "overview" ? AGENTS : [provider];
  const off = settings === null ? [] : covered.filter((a) => !settings.scan[a]);
  const anyOn = settings !== null && off.length < covered.length;
  // A read follows the scan switches, not the other settings.
  const scanKey = settings === null ? "" : AGENTS.map((a) => String(settings.scan[a])).join();

  useEffect(() => {
    if (settings === null || !anyOn) {
      setReport(undefined);
      setRecent(undefined);
      setBusy(false);
      return;
    }
    let stale = false;
    setBusy(true);
    const wanted = refresh.current;
    refresh.current = false;
    const now = new Date();
    const { sinceDay, untilDay } = rangeDays(range, now);
    const agent = provider === "overview" ? null : provider;
    api.kitUsageReport({ sinceDay, untilDay, agent, scope, refresh: wanted }).then(
      (next) => {
        if (stale) return;
        setReport(next);
        setError(undefined);
        setBusy(false);
        // A range of six weeks or more already holds them; a shorter one reads them after it,
        // so the index the range read refreshed is the one read.
        if (range === "all" || Number(range) >= RECENT_DAYS) {
          setRecent(next.summary.days);
          return;
        }
        const [recentSince, recentUntil] = dayRange(RECENT_DAYS, now);
        api.kitUsageReport({ sinceDay: recentSince, untilDay: recentUntil, agent, scope, refresh: false }).then(
          (six) => {
            if (!stale) setRecent(six.summary.days);
          },
          (e) => {
            if (!stale) setError(toApiError(e).code);
          },
        );
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
    // `reads` asks for another read of the same query; `scanKey` changes when a scan switch does.
  }, [api, scanKey, anyOn, provider, scope, range, reads]);

  // Each write returns what was stored; the page and the shared copy show that.
  async function patch(change: Partial<UsageSettings>): Promise<void> {
    if (settings === null || saving.current) return;
    saving.current = true;
    try {
      const stored = await api.usageSettingsPut({ ...getUsageSettings(), ...change });
      setUsageSettings(stored);
      // Turning a scan on reads the logs of that agent from the start.
      if (change.scan) refresh.current = true;
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      saving.current = false;
    }
  }
  const enable = (agent: Agent) => patch({ scan: { ...settings!.scan, [agent]: true } });
  const flip = (group: "footer" | "scan", agent: Agent) => patch({ [group]: { ...settings![group], [agent]: !settings![group][agent] } });
  const sw = (id: string, label: string, on: boolean, flipIt: () => void, hint?: string) => (
    <li className="settings-item" data-switch={id} data-setting-id={id} key={id}>
      <div className="settings-item-text">
        <strong>{label}</strong>
        {hint && <span className="settings-path">{hint}</span>}
      </div>
      <button type="button" role="switch" className="agent-switch" aria-checked={on} aria-label={label} onClick={flipIt} />
    </li>
  );

  const label = (a: Agent) => t(`usage.stats.provider.${a}`);
  const tokens = report === undefined ? 0 : report.by_agent.reduce((n, [, tk]) => n + totalOf(tk), 0);
  const since = report?.tracking_since ? new Date(report.tracking_since).toLocaleDateString() : t("usage.stats.noDate");
  const days = report?.summary.days ?? [];
  const empty = report !== undefined && (days.length === 0 || tokens === 0);
  const cost = report?.cost;
  const costText = cost === undefined ? "–" : formatCost(cost);
  const costNote = cost !== undefined && cost.priced && cost.unpriced ? t("usage.stats.cost.excludes") : undefined;
  const costs = report === undefined ? undefined : Object.fromEntries(report.cost_by_agent.map(([a, c]) => [label(a), formatCost(c)]));
  const claudeTokens = report?.by_agent.find(([a]) => a === "claude")?.[1];
  const reuse = provider === "claude" && claudeTokens !== undefined ? cacheReuse(claudeTokens) : null;
  const recentList = recent ?? [];
  const heat = provider === "overview" ? recentDays(recentList, RECENT_DAYS, new Date()) : [];
  const best = provider === "overview" ? bestDay(days) : null;
  // The card is for one agent: Overview mixes them and has none.
  const shareData: ShareCardData | null =
    report === undefined || provider === "overview"
      ? null
      : {
          provider,
          range,
          untilDay: localDay(new Date()),
          cost: report.cost,
          tokens,
          topModel: report.summary.by_model[0]?.[0] ?? null,
          sessions: report.sessions,
          days: recentList,
        };

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

      {!filter && (
      <>
      <div className="usage-tiles">
        {(
          [
            ["sessions", formatCount(report?.sessions ?? 0, locale)],
            ["tokens", formatCount(tokens, locale)],
            ["cost", costText],
            ["since", since],
          ] as const
        ).map(([key, value]) => (
          <div
            className="usage-tile"
            key={key}
            data-tile={key}
            title={key === "cost" && report !== undefined ? t("usage.stats.cost.asOf", { date: report.prices_as_of }) : undefined}
          >
            <span className="usage-tile-label">{t(`usage.stats.tile.${key}`)}</span>
            <strong className="usage-tile-value">{value}</strong>
            {key === "cost" && costNote !== undefined && <small className="usage-tile-note" data-cost-note>{costNote}</small>}
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
          {shareData !== null && !empty && <UsageShare api={api} data={shareData} />}
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
            <>
              <TokenTable title={t("usage.stats.byProvider")} rows={report.by_agent.map<[string, Tokens]>(([a, tk]) => [label(a), tk])} costs={costs} />
              <section className="kit-block usage-heatmap" aria-label={t("usage.stats.heatmap.title")} data-heatmap>
                <h3 className="kit-h">{t("usage.stats.heatmap.title")}</h3>
                <p className="settings-hint">{t("usage.stats.heatmap.description", { days: RECENT_DAYS })}</p>
                <Heatmap
                  label={t("usage.stats.heatmap.label", { days: RECENT_DAYS })}
                  cells={heat.map((d) => ({ key: d.day, level: d.level, label: t("usage.stats.heatmap.cell", { day: d.day, tokens: formatCount(d.total, locale) }) }))}
                  startWeekday={heat.length === 0 ? 0 : new Date(`${heat[0]!.day}T00:00:00`).getDay()}
                  lessLabel={t("usage.stats.heatmap.less")}
                  moreLabel={t("usage.stats.heatmap.more")}
                />
                {best !== null && <Badge status="neutral">{t("usage.stats.heatmap.best", { day: best })}</Badge>}
              </section>
            </>
          ) : (
            <>
              {reuse !== null && (
                <p className="usage-cache" data-cache-line>
                  <strong>{t("usage.stats.cache.reuse", { percent: Math.round(reuse * 100) })}</strong>
                  <span className="settings-hint">{t("usage.stats.cache.note")}</span>
                </p>
              )}
              <UsageRecentSessions agent={provider} sessions={report.recent_sessions} />
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
      </>
      )}

      {settings && (
        <>
          <SettingGroup ids={CRED_IDS} filter={filter}>
            <h4 className="settings-group">{t("settings.usage.credentials.group")}</h4>
            <SettingRow id="usage.credentials" filter={filter}>
              {accounts !== undefined && accounts.length === 0 ? (
                <p className="kit-empty" data-field="credentials-empty">{t("settings.usage.credentials.empty")}</p>
              ) : (
                <ul className="settings-list">
                  {credentialRows(accounts ?? [], quota).map((r) => (
                    <li className="settings-item" key={r.name} data-credential={r.name}>
                      <div className="settings-item-text">
                        <strong>{t(`usage.stats.provider.${r.provider}`)} · {r.name}</strong>
                        <span className="settings-path" data-field="credential-status">
                          {t(`settings.usage.credentials.status.${r.status}`)}
                          {r.note ? ` · ${t(`settings.usage.credentials.note.${r.note}`)}` : ""}
                        </span>
                      </div>
                      {r.canSignIn && (
                        <button type="button" className="btn-secondary" data-act={`signin-${r.name}`} onClick={() => void signIn(r.name)}>
                          {t("settings.usage.credentials.signIn")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="settings-actions settings-actions-start">
                <button type="button" className="btn-secondary" data-act="check-credentials" disabled={checking} onClick={() => void checkCredentials()}>
                  {t("settings.usage.credentials.check")}
                </button>
              </div>
            </SettingRow>
          </SettingGroup>
          <SettingGroup ids={FOOTER_IDS} filter={filter}>
            <h4 className="settings-group">{t("settings.usage.footerGroup")}</h4>
            <SettingRow id="usage.display" filter={filter}>
              <div className="ws-fields">
                <div className="ws-field" role="radiogroup" aria-label={t("settings.usage.display")}>
                  <span>{t("settings.usage.display")}</span>
                  <div className="segmented">
                    {DISPLAYS.map((d) => (
                      <button key={d} type="button" role="radio" data-display={d} aria-checked={settings.display === d} onClick={() => void patch({ display: d })}>
                        {t(`settings.usage.display.${d}`)}
                      </button>
                    ))}
                  </div>
                  <small className="settings-hint">{t("settings.usage.displayHint")}</small>
                </div>
              </div>
            </SettingRow>
            <ul className="settings-list">
              {AGENTS.map((a) => settingShown(filter, `usage.footer.${a}`) && sw(`usage.footer.${a}`, t(`settings.usage.footer.${a}`), settings.footer[a], () => void flip("footer", a)))}
            </ul>
          </SettingGroup>
          <SettingGroup ids={SCAN_IDS} filter={filter}>
            <h4 className="settings-group">{t("settings.usage.logsGroup")}</h4>
            <ul className="settings-list">
              {AGENTS.map((a) => settingShown(filter, `usage.scan.${a}`) && sw(`usage.scan.${a}`, t(`settings.usage.scan.${a}`), settings.scan[a], () => void flip("scan", a), t("settings.usage.scanHint")))}
            </ul>
          </SettingGroup>
          <SettingGroup ids={CACHE_IDS} filter={filter}>
            <h4 className="settings-group">{t("settings.usage.cacheGroup")}</h4>
            <ul className="settings-list">
              {settingShown(filter, "usage.cacheTimer") &&
                sw("usage.cacheTimer", t("settings.usage.cacheTimer"), settings.cacheTimer, () => void patch({ cacheTimer: !settings.cacheTimer }), t("settings.usage.cacheTimerHint"))}
            </ul>
            {settings.cacheTimer && (
              <SettingRow id="usage.cacheTtl" filter={filter}>
                <div className="ws-fields">
                  <div className="ws-field" role="radiogroup" aria-label={t("settings.usage.cacheTtl")}>
                    <span>{t("settings.usage.cacheTtl")}</span>
                    <div className="segmented">
                      {CACHE_TTLS.map((ms) => (
                        <button key={ms} type="button" role="radio" data-cache-ttl={ms} aria-checked={settings.cacheTtlMs === ms} onClick={() => void patch({ cacheTtlMs: ms })}>
                          {t(ms === CACHE_TTL_LONG_MS ? "settings.usage.cacheTtl.long" : "settings.usage.cacheTtl.short")}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </SettingRow>
            )}
          </SettingGroup>
        </>
      )}
    </div>
  );
}
