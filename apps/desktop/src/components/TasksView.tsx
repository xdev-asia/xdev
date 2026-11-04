import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type FileDiff, type Task, type TaskState, type TasksContext } from "@/api";
import { relativeTime } from "@/changes/changes";
import { useI18n } from "@/i18n";
import { COMPACT, ProblemNote } from "./ChangesPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffView } from "./DiffView";

// A run in this process saves `running` before the agent starts; polling picks up the end of a run
// started before the view mounted (e.g. after switching apps).
const POLL_MS = 5_000;
const GATED: readonly ApiError["code"][] = ["needs_approval", "denied", "policy_invalid"];
// Codes whose detail is the only clue to what went wrong, so it is shown as is.
const WITH_DETAIL: readonly ApiError["code"][] = ["runner", "git"];

type Action = "run" | "resume" | "approve" | "discard";
type Filter = "all" | "review" | "running" | "failed" | "merged";
const FILTERS: readonly Filter[] = ["all", "review", "running", "failed", "merged"];
type Shown = { path: string } & ({ diff: FileDiff } | { problem: ApiError });

export function canRun(state: TaskState): boolean {
  return state === "ready" || state === "paused" || state === "failed";
}
export function canResume(task: Task): boolean {
  return (task.state === "paused" || task.state === "failed") && task.runs.some((r) => r.session_id !== null);
}
export function canDiscard(state: TaskState): boolean {
  return state === "ready" || state === "paused" || state === "review" || state === "failed";
}

function firstLine(goal: string): string {
  return goal.split("\n")[0];
}

// `initial` picks a task to show first, e.g. one a squad worked on.
// `defaultRepo` is the repo a new task goes to when none is picked; it beats the app's own default.
export function TasksView({ api, initial, defaultRepo }: { api: Api; initial?: string; defaultRepo?: string | null }): JSX.Element {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>();
  const [context, setContext] = useState<TasksContext>();
  const [accounts, setAccounts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [problem, setProblem] = useState<ApiError>();
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [test, setTest] = useState("");
  // Task id → the action this view is waiting on.
  const [pending, setPending] = useState<Record<string, Action>>({});
  const [confirming, setConfirming] = useState<{ action: "approve" | "discard"; task: Task } | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let disposed = false;
    Promise.all([api.tasks(), api.tasksContext()]).then(
      ([next, ctx]) => {
        if (disposed) return;
        setTasks(next);
        setContext(ctx);
      },
      (e) => {
        if (!disposed) setProblem(toApiError(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [api, revision]);

  useEffect(() => {
    let disposed = false;
    // Without accounts the run uses the person's own Claude Code setup, so a failure here only hides the choice.
    api.accounts().then(
      (list) => {
        if (!disposed) setAccounts(list.accounts.map((a) => a.name));
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [api]);

  const anyRunning = tasks?.some((task) => task.state === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setRevision((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const task = tasks?.find((x) => x.id === selected) ?? tasks?.[0];
  const busy = task !== undefined && task.id in pending;
  const now = Math.floor(Date.now() / 1000);
  // The UI's own wait counts too: the store only says `running` once the gate has passed.
  const state = (x: Task): TaskState =>
    pending[x.id] === "run" || pending[x.id] === "resume" ? "running" : x.state;
  const filtered = (tasks ?? []).filter((x) => filter === "all" || state(x) === filter);

  function select(id: string) {
    setSelected(id);
    setShown(null);
  }

  async function act(id: string, action: Action, call: () => Promise<Task>) {
    setProblem(undefined);
    setPending((p) => ({ ...p, [id]: action }));
    // Shows `running` from the store while the call is out.
    if (action === "run" || action === "resume") setRevision((n) => n + 1);
    try {
      await call();
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setPending((p) => {
        const { [id]: _, ...rest } = p;
        return rest;
      });
      setRevision((n) => n + 1);
    }
  }

  async function create() {
    setProblem(undefined);
    try {
      const made = await api.newTask(repo ?? defaultRepo ?? context?.defaultRepo ?? "", goal);
      setCreating(false);
      setGoal("");
      select(made.id);
      setRevision((n) => n + 1);
    } catch (e) {
      setProblem(toApiError(e));
    }
  }

  async function browse() {
    const picked = await api.pickFolder();
    if (picked !== null) setRepo(picked);
  }

  async function showFile(id: string, path: string) {
    try {
      setShown({ path, diff: await api.taskFileDiff(id, path) });
    } catch (e) {
      setShown({ path, problem: toApiError(e) });
    }
  }

  function confirm() {
    if (!confirming) return;
    const { action, task: target } = confirming;
    setConfirming(null);
    void act(target.id, action, () => (action === "approve" ? api.approveTask(target.id) : api.discardTask(target.id)));
  }

  function note(p: ApiError) {
    if (!GATED.includes(p.code) && !WITH_DETAIL.includes(p.code)) return <ProblemNote problem={p} />;
    return (
      <div className="banner banner-warn" role="alert">
        <div className="banner-text">
          <span>{t(`error.${p.code}`)}</span>
          {p.detail && (p.code === "needs_approval" || p.code === "denied") && <span>{t("tasks.reason", { reason: p.detail })}</span>}
          {p.detail && WITH_DETAIL.includes(p.code) && <pre className="commands">{p.detail}</pre>}
          {GATED.includes(p.code) && context?.policyPath && (
            <span className="task-policy">{t("tasks.policyFile", { path: context.policyPath })}</span>
          )}
        </div>
      </div>
    );
  }

  function form() {
    const repoValue = repo ?? defaultRepo ?? context?.defaultRepo ?? "";
    return (
      <form
        className="task-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await create();
        }}
      >
        <label>
          {t("tasks.goal")}
          <textarea value={goal} rows={4} placeholder={t("tasks.goalHint")} onChange={(e) => setGoal(e.target.value)} autoFocus />
        </label>
        <label>
          {t("tasks.repo")}
          <span className="task-row">
            <input value={repoValue} onChange={(e) => setRepo(e.target.value)} spellCheck={false} />
            <button type="button" className="btn-secondary" onClick={() => void browse()}>
              {t("tasks.browse")}
            </button>
          </span>
        </label>
        <div className="task-row">
          <Button type="submit" style={COMPACT} disabled={goal.trim() === "" || repoValue.trim() === ""}>
            {t("tasks.create")}
          </Button>
          <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
            {t("tasks.cancel")}
          </button>
        </div>
      </form>
    );
  }

  function diffPane(id: string) {
    if (!shown) return null;
    return (
      <section className="task-diff" aria-label={shown.path}>
        <div className="task-row">
          <h3 className="doc-path">{shown.path}</h3>
          {"diff" in shown && shown.diff.old === null && <span className="badge" data-kind="added">{t("tasks.fileAdded")}</span>}
          {"diff" in shown && shown.diff.new === null && <span className="badge" data-kind="deleted">{t("tasks.fileDeleted")}</span>}
          <button type="button" className="btn-secondary" onClick={() => setShown(null)}>
            {t("tasks.closeDiff")}
          </button>
        </div>
        {"diff" in shown ? (
          <DiffView key={`${id}:${shown.path}`} base={shown.diff.old ?? ""} current={shown.diff.new ?? ""} />
        ) : (
          <p className="pane-empty">{t(`error.${shown.problem.code}`)}</p>
        )}
      </section>
    );
  }

  function detail(x: Task) {
    const s = state(x);
    const evidence = x.evidence;
    const last = x.runs[x.runs.length - 1];
    return (
      <section className="task-detail" aria-label={firstLine(x.goal)}>
        <div className="task-row task-head">
          <h2 className="task-goal">{firstLine(x.goal)}</h2>
          <span className="badge task-state" data-state={s}>
            {t(`tasks.state.${s}`)}
          </span>
        </div>
        {x.goal.includes("\n") && <p className="task-goal-rest">{x.goal.split("\n").slice(1).join("\n").trim()}</p>}
        <dl className="task-facts">
          <dt>{t("tasks.repo")}</dt>
          <dd className="doc-path">{x.repo}</dd>
          <dt>{t("tasks.branch")}</dt>
          <dd className="doc-path">{x.branch}</dd>
          <dt>{t("tasks.runs")}</dt>
          <dd className="task-fact-count">{x.runs.length}</dd>
          {x.approval && (
            <>
              <dt>{t("tasks.state.merged")}</dt>
              <dd className="doc-path">{t("tasks.merged", { commit: x.approval.merge_commit.slice(0, 10) })}</dd>
            </>
          )}
        </dl>

        {s === "running" && (
          <p className="task-working" role="status">
            {t("tasks.working")}
          </p>
        )}

        {(canRun(x.state) || canResume(x) || x.state === "review") && (
          <div className="task-row task-options">
            {accounts.length > 0 && (canRun(x.state) || canResume(x)) && (
              <label>
                {t("tasks.account")}
                <select value={account} onChange={(e) => setAccount(e.target.value)} disabled={busy}>
                  <option value="">{t("tasks.ownAccount")}</option>
                  {accounts.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {canRun(x.state) && (
              <label>
                {t("tasks.testCommand")}
                <input value={test} onChange={(e) => setTest(e.target.value)} disabled={busy} spellCheck={false} />
              </label>
            )}
          </div>
        )}
        <div className="task-row">
          <Button
            type="button"
            style={COMPACT}
            disabled={busy || !canRun(x.state)}
            onClick={() => act(x.id, "run", () => api.runTask(x.id, account || null, test.trim() || null))}
          >
            {t("tasks.runAction")}
          </Button>
          <Button
            type="button"
            style={COMPACT}
            disabled={busy || !canResume(x)}
            onClick={() => act(x.id, "resume", () => api.resumeTask(x.id, account || null))}
          >
            {t("tasks.resume")}
          </Button>
          <Button
            type="button"
            style={COMPACT}
            disabled={busy || x.state !== "review"}
            onClick={() => setConfirming({ action: "approve", task: x })}
          >
            {t("tasks.approve")}
          </Button>
          <button
            type="button"
            className="btn-secondary task-discard"
            disabled={busy || !canDiscard(x.state)}
            onClick={() => setConfirming({ action: "discard", task: x })}
          >
            {t("tasks.discard")}
          </button>
        </div>

        <h3>{t("tasks.runs")}</h3>
        {x.runs.length === 0 ? (
          <p className="pane-empty">{t("tasks.noRuns")}</p>
        ) : (
          <ul className="task-runs">
            {x.runs.map((run) => (
              <li key={run.started} className="task-row task-run" data-run={run.ended === null ? "running" : run.is_error ? "error" : "ok"}>
                <span className="task-run-time">{new Date(run.started * 1000).toLocaleString()}</span>
                <span>{run.cost_usd === null ? t("tasks.noCost") : t("tasks.cost", { cost: run.cost_usd.toFixed(4) })}</span>
                <span className="badge" data-run={run.ended === null ? "running" : run.is_error ? "error" : "ok"}>
                  {t(`tasks.run.${run.ended === null ? "running" : run.is_error ? "error" : "ok"}`)}
                </span>
                {run.session_id && <span className="doc-path">{t("tasks.session", { id: run.session_id })}</span>}
              </li>
            ))}
          </ul>
        )}
        {last?.summary && (
          <>
            <h3>{t("tasks.lastMessage")}</h3>
            <pre className="task-output">{last.summary}</pre>
          </>
        )}

        <h3>{t("tasks.files")}</h3>
        {evidence === null ? (
          <p className="pane-empty">{t("tasks.noEvidence")}</p>
        ) : evidence.files.length === 0 ? (
          <p className="pane-empty">{t("tasks.noFiles")}</p>
        ) : (
          <ul className="task-files">
            {evidence.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="task-file"
                  aria-pressed={shown?.path === file.path}
                  onClick={() => void showFile(x.id, file.path)}
                >
                  <span className="task-count" data-kind="added">
                    +{file.added ?? "-"}
                  </span>
                  <span className="task-count" data-kind="deleted">
                    -{file.removed ?? "-"}
                  </span>
                  <span className="doc-path">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {diffPane(x.id)}

        {evidence && (
          <>
            <h3>{t("tasks.test")}</h3>
            {evidence.test === null ? (
              <p className="pane-empty">{t("tasks.noTest")}</p>
            ) : (
              <>
                <div className="task-row">
                  <code>{evidence.test.command.join(" ")}</code>
                  <span className="badge" data-run={evidence.test.exit === 0 ? "ok" : "error"}>
                    {evidence.test.exit === null ? t("tasks.testKilled") : t("tasks.testExit", { code: evidence.test.exit })}
                  </span>
                </div>
                <pre className="task-output">{evidence.test.output_tail}</pre>
              </>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <div className="tasks-view">
      <div className="agentctx-head">
        <div className="doc-titles">
          <h1 className="doc-title">{t("tasks.title")}</h1>
          <span className="doc-subtitle">{t("tasks.subtitle")}</span>
        </div>
        <div className="doc-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setProblem(undefined);
              setRevision((n) => n + 1);
            }}
          >
            {t("tasks.refresh")}
          </button>
          <Button type="button" style={COMPACT} onClick={() => setCreating(true)}>
            {t("tasks.new")}
          </Button>
        </div>
      </div>
      {problem && note(problem)}
      {creating && form()}
      {tasks === undefined ? (
        !problem && <p className="placeholder">{t("tasks.loading")}</p>
      ) : tasks.length === 0 ? (
        !creating && <p className="placeholder">{t("tasks.empty")}</p>
      ) : (
        <div className="tasks-body">
          <div className="task-aside">
            <div className="task-filters" role="group" aria-label={t("tasks.filterLabel")}>
              {FILTERS.map((f) => (
                <button key={f} type="button" className="task-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  <span>{f === "all" ? t("tasks.filter.all") : t(`tasks.state.${f}`)}</span>
                  <span className="task-chip-count">{f === "all" ? tasks.length : tasks.filter((x) => state(x) === f).length}</span>
                </button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <p className="pane-empty">{t("tasks.filterEmpty")}</p>
            ) : (
              <ul className="task-list" aria-label={t("tasks.title")}>
                {filtered.map((x) => {
                  const age = relativeTime(now, x.created);
                  return (
                    <li key={x.id}>
                      <button type="button" className="task-item" aria-current={x.id === task?.id ? "true" : undefined} onClick={() => select(x.id)}>
                        <span className="task-item-top">
                          <span className="task-item-goal">{firstLine(x.goal)}</span>
                          <span className="badge task-state" data-state={state(x)}>
                            {t(`tasks.state.${state(x)}`)}
                          </span>
                        </span>
                        <span className="task-item-meta">
                          <span className="task-item-branch">{x.branch}</span>
                          <span className="task-item-age">{t(age.key, age.vars)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {task ? detail(task) : <p className="placeholder">{t("tasks.select")}</p>}
        </div>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={t(confirming?.action === "discard" ? "tasks.confirmDiscard.title" : "tasks.confirmApprove.title")}
        body={t(confirming?.action === "discard" ? "tasks.confirmDiscard.body" : "tasks.confirmApprove.body", {
          branch: confirming?.task.branch ?? "",
        })}
        confirmLabel={t(confirming?.action === "discard" ? "tasks.confirmDiscard.confirm" : "tasks.confirmApprove.confirm")}
        onConfirm={confirm}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
