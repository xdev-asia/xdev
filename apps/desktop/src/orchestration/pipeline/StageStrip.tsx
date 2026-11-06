import { Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type Pipeline } from "@/api";
import { COMPACT, ProblemNote } from "@/components/ChangesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { actionsFor, currentIndex, gateText, isDone, presetStages, progress, STATUS_KEYS, type StageAction } from "./stages";
import "./pipeline.css";

const POLL_MS = 5_000;

export interface StageStripProps {
  api: Api;
  /** What the stages belong to: `squad:<id>` or `task:<id>`. */
  subject: string;
  /** Where check commands run. */
  worktree: string;
  /** The check the tests stage starts with, such as the squad's test command. */
  defaultCheck?: string;
  pollMs?: number;
}

type Asked = { id: string; action: "approve" | "retry" };

export function StageStrip({ api, subject, worktree, defaultCheck = "", pollMs = POLL_MS }: StageStripProps): JSX.Element {
  const { t } = useI18n();
  const [list, setList] = useState<Pipeline[]>();
  const [problem, setProblem] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(defaultCheck);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [said, setSaid] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    api.pipelines(subject).then(
      (next) => {
        if (!disposed) setList(next);
      },
      (e) => {
        if (!disposed) setProblem(toApiError(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [api, subject, revision]);

  // An approval may be answered somewhere else (the mission's gate list), so a waiting stage is looked at again.
  const waiting = list?.some((p) => p.stages.some((s) => s.status === "waiting")) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setRevision((n) => n + 1), pollMs);
    return () => clearInterval(timer);
  }, [waiting, pollMs]);

  /** Runs one call, keeps what it answered and says what became of the stage it was about. */
  async function run(before: Pipeline | null, call: () => Promise<Pipeline>): Promise<void> {
    setBusy(true);
    setProblem(undefined);
    try {
      const after = await call();
      setList((prev) => (prev ? (prev.some((p) => p.id === after.id) ? prev.map((p) => (p.id === after.id ? after : p)) : [after, ...prev]) : [after]));
      setSaid(announce(before, after));
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
      setRevision((n) => n + 1);
    }
  }

  function announce(before: Pipeline | null, after: Pipeline): string {
    if (before === null) return t("pipeline.announce.started", { name: after.name });
    if (isDone(after)) return t("pipeline.announce.done", { name: after.name });
    const i = currentIndex(before);
    const stage = after.stages[i];
    if (stage.status === "passed") return t("pipeline.announce.passed", { stage: stage.name, next: after.stages[currentIndex(after)].name });
    if (stage.status === "failed") return t("pipeline.announce.failed", { stage: stage.name, reason: stage.reason ?? "" });
    return t("pipeline.announce.waiting", { stage: stage.name });
  }

  function start() {
    const stages = presetStages(check, {
      implement: t("pipeline.preset.implement"),
      tests: t("pipeline.preset.tests"),
      review: t("pipeline.preset.review"),
      question: t("pipeline.preset.question"),
    });
    void run(null, () => api.newPipeline(t("pipeline.preset.name"), subject, worktree, stages));
  }

  function act(p: Pipeline, action: StageAction) {
    if (action === "handOff") void run(p, () => api.pipelineHandOff(p.id));
    else if (action === "decline") void run(p, () => api.pipelineDecide(p.id, false, null));
    else setAsked({ id: p.id, action });
  }

  function confirmed() {
    const p = list?.find((x) => x.id === asked?.id);
    const action = asked?.action;
    setAsked(null);
    if (!p || !action) return;
    if (action === "retry") void run(p, () => api.pipelineRetry(p.id));
    else void run(p, () => api.pipelineDecide(p.id, true, null));
  }

  function stage(p: Pipeline, i: number): JSX.Element {
    const s = p.stages[i];
    const gate = gateText(s.gate);
    const here = i === currentIndex(p);
    return (
      <li key={i} className="stage" data-status={s.status} aria-current={here ? "step" : undefined}>
        <span className="stage-head">
          <span className="stage-dot" data-status={s.status} aria-hidden="true" />
          <span className="stage-name">{s.name}</span>
          <span className="badge stage-state" data-status={s.status}>{t(STATUS_KEYS[s.status])}</span>
        </span>
        <span className="stage-gate">
          {gate.key === "check" ? t("pipeline.gate.check", { command: gate.command ?? "" }) : t(`pipeline.gate.${gate.key}`)}
        </span>
        {s.reason && s.status !== "passed" && (
          <span className="stage-reason" data-status={s.status}>
            {s.status === "failed" ? t("pipeline.why", { reason: s.reason }) : s.reason}
          </span>
        )}
      </li>
    );
  }

  function strip(p: Pipeline): JSX.Element {
    const { passed, total } = progress(p);
    return (
      <div className="pipeline-run" key={p.id}>
        <div className="task-row">
          <strong className="pipeline-name">{p.name}</strong>
          <span className="doc-subtitle">{t("pipeline.progress", { passed, total })}</span>
        </div>
        <ol className="stage-strip" aria-label={t("pipeline.stages", { name: p.name })}>
          {p.stages.map((_, i) => stage(p, i))}
        </ol>
        <div className="task-row stage-actions">
          {actionsFor(p).map((a) => (
            <button key={a} type="button" className="btn-secondary" disabled={busy} onClick={() => act(p, a)}>
              {t(`pipeline.action.${a}`)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const latest = list?.[0];
  const askedPipeline = list?.find((p) => p.id === asked?.id);
  const askedStage = askedPipeline ? askedPipeline.stages[currentIndex(askedPipeline)] : undefined;
  return (
    <section className="squad-card pipeline" aria-label={t("pipeline.title")}>
      <h3 className="squad-card-title">{t("pipeline.title")}</h3>
      {problem && <ProblemNote problem={problem} />}
      {list === undefined ? (
        !problem && <p className="pane-empty">{t("pipeline.loading")}</p>
      ) : (
        <>
          {list.map(strip)}
          {(latest === undefined || isDone(latest)) && (
            <form
              className="task-form pipeline-form"
              aria-label={t("pipeline.new")}
              onSubmit={(e) => {
                e.preventDefault();
                start();
              }}
            >
              <p className="doc-subtitle">{t("pipeline.hint")}</p>
              <label>
                {t("pipeline.checkCommand")}
                <input value={check} placeholder={t("pipeline.checkHint")} spellCheck={false} onChange={(e) => setCheck(e.target.value)} />
              </label>
              <button type="submit" className="btn-secondary" disabled={busy}>
                {t("pipeline.start")}
              </button>
            </form>
          )}
        </>
      )}
      <p className="pipeline-status" role="status">{said}</p>
      <ConfirmDialog
        titleId="pipeline-confirm-title"
        open={asked !== null}
        title={asked?.action === "retry" ? t("pipeline.confirmRetry.title") : t("pipeline.confirmApprove.title")}
        body={
          asked?.action === "retry"
            ? t("pipeline.confirmRetry.body", { stage: askedStage?.name ?? "" })
            : t("pipeline.confirmApprove.body", { stage: askedStage?.name ?? "" })
        }
        confirmLabel={asked?.action === "retry" ? t("pipeline.action.retry") : t("pipeline.action.approve")}
        onConfirm={confirmed}
        onCancel={() => setAsked(null)}
      />
    </section>
  );
}
