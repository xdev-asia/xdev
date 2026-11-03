import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type Home, type UsageSummary } from "../api";
import { useI18n } from "../i18n";
import { UsageChart } from "./UsageChart";
import { dayRange, homeLabel, relativeFolder, totalOf, type Tokens } from "./kitUi";

type Range = 7 | 30;

/** One table of names and their tokens: input, output, cache and the total. */
function TokenTable(props: { title: string; rows: Array<[string, Tokens]> }): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="kit-block" aria-label={props.title}>
      <h3 className="kit-h">{props.title}</h3>
      <table className="kit-table">
        <thead>
          <tr>
            <th scope="col">{t("kit.usage.col.name")}</th>
            <th scope="col" className="kit-num">{t("kit.usage.input")}</th>
            <th scope="col" className="kit-num">{t("kit.usage.output")}</th>
            <th scope="col" className="kit-num">{t("kit.usage.cache")}</th>
            <th scope="col" className="kit-num">{t("kit.usage.total")}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map(([name, tokens]) => (
            <tr key={name} data-row={name}>
              <td className="kit-cut" title={name}>{name}</td>
              <td className="kit-num">{tokens.input}</td>
              <td className="kit-num">{tokens.output}</td>
              <td className="kit-num">{tokens.cache_read + tokens.cache_write}</td>
              <td className="kit-num">{totalOf(tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Token use per day, home, folder and model, from the agents' own session logs. */
export function UsageView(props: { usage: UsageSummary; homes: Home[]; roots: string[] }): JSX.Element {
  const { t } = useI18n();
  const { usage, homes, roots } = props;
  const folder = (f: string | null) => (f === null ? t("kit.usage.noFolder") : relativeFolder(f, roots));
  const total = usage.days.reduce((n, [, tokens]) => n + totalOf(tokens), 0);
  if (usage.days.length === 0 || total === 0) return <p className="kit-empty">{t("kit.usage.none")}</p>;
  return (
    <>
      <div className="kit-legend" aria-hidden="true">
        {(["input", "output", "cache"] as const).map((part) => (
          <span key={part} className="kit-legend-item" data-series={part}>
            <span className={`kit-swatch kit-bar-${part}`} />
            {t(`kit.usage.${part}`)}
          </span>
        ))}
        <span className="kit-legend-total">{t("kit.tokens", { count: total })}</span>
      </div>
      <UsageChart days={usage.days} />
      <TokenTable title={t("kit.usage.byHome")} rows={usage.by_home.map<[string, Tokens]>(([id, tokens]) => [homeLabel(homes, id, t), tokens])} />
      <TokenTable title={t("kit.usage.byFolder")} rows={usage.by_folder.map<[string, Tokens]>(([f, tokens]) => [relativeFolder(f, roots), tokens])} />
      <TokenTable title={t("kit.usage.byModel")} rows={usage.by_model} />
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
            {usage.top_sessions.map((s) => (
              <tr key={`${s.home_id}/${s.id}`} data-session={s.id}>
                <td className="kit-cut" title={s.id}>{`${homeLabel(homes, s.home_id, t)} · ${s.id.slice(0, 8)}`}</td>
                <td className="kit-cut" title={s.folder ?? ""}>{folder(s.folder)}</td>
                <td className="kit-cut">{s.model ?? t("kit.usage.noModel")}</td>
                <td>{s.last > 0 ? new Date(s.last).toLocaleString() : "–"}</td>
                <td className="kit-num">{totalOf(s.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export function UsageTab(props: { api: Api }): JSX.Element {
  const { t } = useI18n();
  const { api } = props;
  const [range, setRange] = useState<Range>(7);
  const [usage, setUsage] = useState<UsageSummary>();
  const [homes, setHomes] = useState<Home[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState(0);
  // Set by the Refresh button for the next read only.
  const refresh = useRef(false);

  useEffect(() => {
    let stale = false;
    api.kitHomes().then((list) => !stale && setHomes(list), () => undefined);
    // Folders show relative to a registered repo when one holds them; none registered is fine.
    api.workspaceList().then((repos) => !stale && setRoots(repos.map((r) => r.path)), () => undefined);
    return () => {
      stale = true;
    };
  }, [api]);

  useEffect(() => {
    let stale = false;
    setBusy(true);
    const [since, until] = dayRange(range, new Date());
    const wanted = refresh.current;
    refresh.current = false;
    api.kitUsage(since, until, wanted).then(
      (summary) => {
        if (stale) return;
        setUsage(summary);
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
    // `reads` asks for another read of the same range.
  }, [api, range, reads]);

  return (
    <div className="kit-usage">
      <div className="kit-bar-row">
        <div className="kit-switch" role="group" aria-label={t("kit.usage.range")}>
          {([7, 30] as const).map((n) => (
            <button key={n} type="button" className="btn-secondary kit-switch-item" aria-pressed={range === n} data-range={n} onClick={() => setRange(n)}>
              {t(`kit.usage.days${n}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            refresh.current = true;
            setReads((n) => n + 1);
          }}
        >
          {t("kit.usage.refresh")}
        </button>
      </div>
      {error && <p className="error-text" role="alert">{t(`error.${error}`)}</p>}
      {usage ? <UsageView usage={usage} homes={homes} roots={roots} /> : !error && <p className="kit-empty">{t("kit.loading")}</p>}
    </div>
  );
}
