import { useEffect, useState } from "react";
import type { JSX } from "react";
import { PROVIDERS, toApiError, type Api, type ApiError, type SwarmRow } from "@/api";
import { ProblemNote } from "@/components/ChangesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { clampCount, counts, isLive, SWARM_DEFAULT, SWARM_MAX } from "./progress";
import "./swarm.css";

const POLL_MS = 3_000;

export interface SwarmPanelProps {
  api: Api;
  /** The worktree the workers start from, when the person has no tab to start from. */
  worktree: string;
  /** The tab the swarm starts from, when there is one. */
  tab?: string | null;
  pollMs?: number;
}

export function SwarmPanel({ api, worktree, tab = null, pollMs = POLL_MS }: SwarmPanelProps): JSX.Element {
  const { t } = useI18n();
  const [goal, setGoal] = useState("");
  const [count, setCount] = useState(String(SWARM_DEFAULT));
  const [agent, setAgent] = useState<string>(PROVIDERS[0]);
  const [run, setRun] = useState<string | null>(null);
  const [rows, setRows] = useState<SwarmRow[]>([]);
  const [problem, setProblem] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);
  const [said, setSaid] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (run === null) return;
    let disposed = false;
    api.swarmWorkers(run).then(
      (next) => {
        if (!disposed) setRows(next);
      },
      (e) => {
        if (!disposed) setProblem(toApiError(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [api, run, revision]);

  const { live } = counts(rows);
  useEffect(() => {
    if (live === 0) return;
    const timer = setInterval(() => setRevision((n) => n + 1), pollMs);
    return () => clearInterval(timer);
  }, [live, pollMs]);

  async function start() {
    setBusy(true);
    setProblem(undefined);
    try {
      const n = clampCount(count);
      const got = await api.swarmStart(goal.trim(), n, agent, tab, worktree);
      setCount(String(got.started.size));
      setRun(got.run);
      setOpened([]);
      setSaid(
        got.started.failed.length === 0
          ? t("swarm.announce.started", { count: got.started.workers.length })
          : t("swarm.announce.partial", { count: got.started.workers.length, failed: got.started.failed.length }),
      );
      setRevision((x) => x + 1);
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    if (run === null) return;
    setConfirming(false);
    setBusy(true);
    setProblem(undefined);
    try {
      const got = await api.swarmStopAll(run);
      setSaid(t("swarm.announce.stopped", { count: got.stopped.length }));
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
      setRevision((x) => x + 1);
    }
  }

  async function open(row: SwarmRow) {
    if (row.tab === null) return;
    setProblem(undefined);
    try {
      await api.swarmOpenTab(row.tab);
      setOpened((o) => (o.includes(row.dispatch) ? o : [...o, row.dispatch]));
      setSaid(t("swarm.announce.opened", { worker: row.tab }));
    } catch (e) {
      setProblem(toApiError(e));
    }
  }

  function item(row: SwarmRow, i: number): JSX.Element {
    const name = t("swarm.worker", { n: i + 1 });
    return (
      <li key={row.dispatch} className="swarm-row" data-state={row.state} aria-label={name}>
        <span className="swarm-head">
          <strong className="swarm-name">{name}</strong>
          <span className="badge swarm-state" data-state={row.state}>{t(`swarm.state.${row.state}`)}</span>
          {opened.includes(row.dispatch) && <span className="swarm-opened">{t("swarm.opened")}</span>}
        </span>
        <span className="swarm-line" title={row.lastLine}>{row.lastLine === "" ? t("swarm.noOutput") : row.lastLine}</span>
        <button type="button" className="btn-secondary" disabled={row.tab === null} aria-label={t("swarm.openLabel", { name })} onClick={() => void open(row)}>
          {t("swarm.open")}
        </button>
      </li>
    );
  }

  const n = clampCount(count);
  return (
    <section className="squad-card swarm" aria-label={t("swarm.title")}>
      <h3 className="squad-card-title">{t("swarm.title")}</h3>
      <p className="doc-subtitle">{t("swarm.hint", { max: SWARM_MAX })}</p>
      {problem && <ProblemNote problem={problem} />}
      <form
        className="task-form swarm-form"
        aria-label={t("swarm.start")}
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label>
          {t("tasks.goal")}
          <input value={goal} placeholder={t("swarm.goalHint")} disabled={busy} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <div className="task-row">
          <label>
            {t("swarm.count")}
            <input type="number" min={1} max={SWARM_MAX} value={count} disabled={busy} onChange={(e) => setCount(e.target.value)} onBlur={() => setCount(String(n))} />
          </label>
          <label>
            {t("swarm.agent")}
            <select value={agent} disabled={busy} onChange={(e) => setAgent(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{t(`accounts.provider.${p}`)}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-secondary" disabled={busy || goal.trim() === ""}>
            {t("swarm.start")}
          </button>
        </div>
      </form>
      {rows.length > 0 && (
        <>
          <div className="task-row">
            <strong>{t("swarm.progress", { live, total: rows.length })}</strong>
            <button type="button" className="btn-secondary" disabled={busy || live === 0} onClick={() => setConfirming(true)}>
              {t("swarm.stopAll")}
            </button>
          </div>
          <ul className="swarm-list" aria-label={t("swarm.listLabel")}>{rows.map(item)}</ul>
        </>
      )}
      <p className="swarm-status" role="status">{said}</p>
      <ConfirmDialog
        titleId="swarm-confirm-title"
        open={confirming}
        title={t("swarm.confirmStop.title")}
        body={t("swarm.confirmStop.body", { count: rows.filter(isLive).length })}
        confirmLabel={t("swarm.stopAll")}
        onConfirm={() => void stopAll()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
