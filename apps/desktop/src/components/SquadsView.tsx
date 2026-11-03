import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  toApiError,
  type Account,
  type Api,
  type ApiError,
  type Escalation,
  type Quota,
  type Role,
  type SeatState,
  type SquadEvent,
  type SquadItem,
  type SquadStatus,
  type SquadView as View,
  type TasksContext,
} from "@/api";
import { relativeTime } from "@/changes/changes";
import { useI18n } from "@/i18n";
import { COMPACT, ProblemNote } from "./ChangesPanel";
import { ConfirmDialog } from "./ConfirmDialog";

const POLL_MS = 3_000;
export const ROLES: readonly Role[] = ["lead", "implement", "tests", "review"];
const GATED: readonly ApiError["code"][] = ["needs_approval", "denied"];
// Event kinds the store writes; anything newer is shown as the store wrote it.
const EVENT_KINDS = new Set([
  "start", "step", "turn", "reply", "escalation", "answer", "steer", "resume",
  "stop", "needs_you", "skip", "test", "review", "done", "error", "recovered", "seat",
]);
const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;

// Calls that wait on the run; steer and stop answer at once even while one is out.
type Action = "run" | "answer" | "resume" | "seat" | "remove";

export type RingLevel = "accent" | "warn" | "danger";

// The thresholds the person reads as "fine", "getting full" and "about to forget".
export function ringLevel(percent: number): RingLevel {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "accent";
}

export function contextPercent(seat: SeatState | undefined): number | null {
  const c = seat?.context;
  if (!c || c.window <= 0) return null;
  return Math.min(100, Math.round((c.used / c.window) * 100));
}

function folder(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// A seat as the page shows it, with or without a run.
function seatState(view: View, role: Role): SeatState {
  const fromRun = view.run?.seats[role];
  if (fromRun) return fromRun;
  const account = view.squad.seats.find((s) => s.role === role)?.account ?? null;
  return { state: account === null ? "vacant" : "idle", session: null, context: null, last: "", wait: null, queued: [] };
}

export function Ring(props: { percent: number | null; monogram: string }): JSX.Element {
  const level = props.percent === null ? undefined : ringLevel(props.percent);
  return (
    <svg className="squad-ring" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true" data-level={level}>
      <circle className="squad-ring-track" cx="20" cy="20" r={RING_R} />
      {props.percent !== null && (
        <circle
          className="squad-ring-used"
          cx="20"
          cy="20"
          r={RING_R}
          strokeDasharray={`${(RING_C * props.percent) / 100} ${RING_C}`}
          transform="rotate(-90 20 20)"
        />
      )}
      <text className="squad-ring-mark" x="20" y="20" textAnchor="middle" dominantBaseline="central">
        {props.monogram}
      </text>
    </svg>
  );
}

export function SquadsView({ api, onOpenTask }: { api: Api; onOpenTask?(task: string): void }): JSX.Element {
  const { t } = useI18n();
  const [items, setItems] = useState<SquadItem[]>();
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [context, setContext] = useState<TasksContext>();
  const [problem, setProblem] = useState<ApiError>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [seats, setSeats] = useState<Record<Role, string>>({ lead: "", implement: "", tests: "", review: "" });
  const [test, setTest] = useState("");
  const [goal, setGoal] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Squad id → the call this view is waiting on.
  const [pending, setPending] = useState<Record<string, Action>>({});
  const [sheet, setSheet] = useState<Role | null>(null);
  const [steer, setSteer] = useState("");
  const [seatAccount, setSeatAccount] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [allEvents, setAllEvents] = useState<SquadEvent[] | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    api.squads().then(
      (next) => {
        if (!disposed) setItems(next);
      },
      (e) => {
        if (!disposed) setProblem(toApiError(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [api, revision]);

  const current = selected ?? items?.[0]?.squad.id ?? null;
  useEffect(() => {
    if (current === null) return;
    let disposed = false;
    api.squad(current).then(
      (next) => {
        if (!disposed) setView(next);
      },
      (e) => {
        if (!disposed) setProblem(toApiError(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [api, current, revision]);

  useEffect(() => {
    let disposed = false;
    // Without accounts or quota the seat menus just have less to say, so failures stay quiet.
    Promise.all([api.accounts(), api.quota().catch(() => [] as Quota[]), api.tasksContext().catch(() => undefined)]).then(
      ([list, usage, ctx]) => {
        if (disposed) return;
        setAccounts(list.accounts);
        setQuotas(usage);
        setContext(ctx);
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [api]);

  const shown = view !== undefined && view.squad.id === current ? view : undefined;
  // The UI's own wait counts too: the store only says `running` once the run has started.
  const status = (id: string, s: SquadStatus): SquadStatus => {
    const p = pending[id];
    return p === "run" || p === "answer" || p === "resume" ? "running" : s;
  };
  const active = shown ? status(shown.squad.id, shown.status) : "idle";
  const polling = active === "running" || (items?.some((i) => status(i.squad.id, i.status) === "running") ?? false);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setRevision((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  function select(id: string) {
    setSelected(id);
    setSheet(null);
    setAllEvents(null);
    setGoal("");
  }

  async function act(id: string, action: Action, call: () => Promise<unknown>): Promise<boolean> {
    setProblem(undefined);
    setPending((p) => ({ ...p, [id]: action }));
    // Shows the store's `running` while the call is out.
    setRevision((n) => n + 1);
    try {
      await call();
      return true;
    } catch (e) {
      setProblem(toApiError(e));
      return false;
    } finally {
      setPending((p) => {
        const { [id]: _, ...rest } = p;
        return rest;
      });
      setAllEvents(null);
      setRevision((n) => n + 1);
    }
  }

  async function quick(call: () => Promise<unknown>): Promise<boolean> {
    setProblem(undefined);
    try {
      await call();
      return true;
    } catch (e) {
      setProblem(toApiError(e));
      return false;
    } finally {
      setAllEvents(null);
      setRevision((n) => n + 1);
    }
  }

  async function create() {
    setProblem(undefined);
    try {
      const made = await api.newSquad(
        name,
        repo ?? context?.defaultRepo ?? "",
        ROLES.map((role) => ({ role, account: seats[role] === "" ? null : seats[role] })),
        test.trim() === "" ? null : test,
      );
      setCreating(false);
      setName("");
      setTest("");
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

  async function showAll(id: string) {
    try {
      setAllEvents(await api.squadEvents(id));
    } catch (e) {
      setProblem(toApiError(e));
    }
  }

  function provider(account: string | null): Account["provider"] | null {
    return accounts.find((a) => a.name === account)?.provider ?? null;
  }

  function accountOption(a: Account) {
    const state = quotas.find((q) => q.name === a.name)?.state ?? "unknown";
    return (
      <option key={a.name} value={a.name}>
        {t("squads.accountOption", { name: a.name, provider: t(`accounts.provider.${a.provider}`), quota: t(`accounts.state.${state}`) })}
      </option>
    );
  }

  function note(p: ApiError) {
    if (!GATED.includes(p.code) || !p.detail) return <ProblemNote problem={p} />;
    return (
      <div className="banner banner-warn" role="alert">
        <div className="banner-text">
          <span>{t(`error.${p.code}`)}</span>
          <span>{t("tasks.reason", { reason: p.detail })}</span>
          {context?.policyPath && <span className="task-policy">{t("tasks.policyFile", { path: context.policyPath })}</span>}
        </div>
      </div>
    );
  }

  function form() {
    const repoValue = repo ?? context?.defaultRepo ?? "";
    return (
      <form
        className="task-form"
        aria-label={t("squads.new")}
        onSubmit={async (e) => {
          e.preventDefault();
          await create();
        }}
      >
        <label>
          {t("squads.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
        <div className="squad-seat-fields">
          {ROLES.map((role) => (
            <label key={role}>
              {t(`squads.role.${role}`)}
              <select value={seats[role]} onChange={(e) => setSeats((s) => ({ ...s, [role]: e.target.value }))}>
                <option value="">{t("squads.vacant")}</option>
                {accounts.map(accountOption)}
              </select>
            </label>
          ))}
        </div>
        <label>
          {t("tasks.testCommand")}
          <input value={test} onChange={(e) => setTest(e.target.value)} spellCheck={false} />
        </label>
        <div className="task-row">
          <Button type="submit" style={COMPACT} disabled={name.trim() === "" || repoValue.trim() === "" || seats.implement === ""}>
            {t("squads.create")}
          </Button>
          <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
            {t("tasks.cancel")}
          </button>
        </div>
      </form>
    );
  }

  function seatButton(v: View, role: Role) {
    const s = seatState(v, role);
    const account = v.squad.seats.find((x) => x.role === role)?.account ?? null;
    const p = provider(account);
    const percent = contextPercent(s);
    const line =
      s.state === "needs_you" || s.state === "vacant" || s.state === "skipped"
        ? t(`squads.seat.${s.state}`)
        : [p === null ? account : t(`accounts.provider.${p}`), percent === null ? null : `${percent}%`].filter(Boolean).join(" · ");
    return (
      <button
        type="button"
        className="squad-seat"
        data-role={role}
        data-state={s.state}
        aria-pressed={sheet === role}
        onClick={() => {
          setSheet(role);
          setSteer("");
          setSeatAccount(null);
        }}
      >
        <Ring percent={percent} monogram={p === "codex" ? "X" : p === "claude" ? "C" : ""} />
        <span className="squad-seat-text">
          <span className="squad-seat-role">
            <span className="squad-dot" data-state={s.state} />
            {t(`squads.role.${role}`)}
          </span>
          <span className="squad-seat-line">{line}</span>
        </span>
      </button>
    );
  }

  function seatSheet(v: View, role: Role) {
    const s = seatState(v, role);
    const account = v.squad.seats.find((x) => x.role === role)?.account ?? null;
    const p = provider(account);
    const quota = quotas.find((q) => q.name === account)?.state ?? "unknown";
    const busy = v.squad.id in pending;
    const running = status(v.squad.id, v.status) === "running";
    const choice = seatAccount ?? account ?? "";
    return (
      <aside className="squad-sheet" aria-label={t(`squads.role.${role}`)}>
        <div className="task-row">
          <h3>{t(`squads.role.${role}`)}</h3>
          <span className="badge squad-state" data-state={s.state}>
            {t(`squads.seat.${s.state}`)}
          </span>
          <button type="button" className="btn-secondary squad-sheet-close" onClick={() => setSheet(null)}>
            {t("squads.close")}
          </button>
        </div>
        <dl className="task-facts">
          <dt>{t("tasks.account")}</dt>
          <dd>{account === null ? t("squads.vacant") : `${account}${p === null ? "" : ` · ${t(`accounts.provider.${p}`)}`}`}</dd>
          {account !== null && (
            <>
              <dt>{t("squads.quota")}</dt>
              <dd>{t(`accounts.state.${quota}`)}</dd>
            </>
          )}
          <dt>{t("squads.session")}</dt>
          <dd className="doc-path">{s.session ?? t("squads.noSession")}</dd>
        </dl>
        <h4>{t("tasks.lastMessage")}</h4>
        {s.last === "" ? <p className="pane-empty">{t("squads.noMessage")}</p> : <pre className="task-output">{s.last}</pre>}
        {s.queued.length > 0 && <p className="pane-empty">{t("squads.queued", { count: s.queued.length })}</p>}
        <form
          className="task-form squad-sheet-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await quick(() => api.steerSquad(v.squad.id, role, steer))) setSteer("");
          }}
        >
          <label>
            {t("squads.steer")}
            <textarea value={steer} rows={3} placeholder={t("squads.steerHint")} onChange={(e) => setSteer(e.target.value)} />
          </label>
          <Button type="submit" style={COMPACT} disabled={steer.trim() === "" || account === null || v.run === null}>
            {t("squads.send")}
          </Button>
        </form>
        <form
          className="task-form squad-sheet-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(v.squad.id, "seat", () => api.setSeat(v.squad.id, role, choice === "" ? null : choice))) setSeatAccount(null);
          }}
        >
          <label>
            {t("squads.changeAccount")}
            <select value={choice} onChange={(e) => setSeatAccount(e.target.value)} disabled={running}>
              <option value="">{t("squads.vacant")}</option>
              {accounts.map(accountOption)}
            </select>
          </label>
          <Button type="submit" style={COMPACT} disabled={running || busy || choice === (account ?? "")}>
            {t("squads.save")}
          </Button>
        </form>
      </aside>
    );
  }

  function escalation(v: View, e: Escalation, now: number) {
    const age = relativeTime(now, e.at);
    const open = e.to === "person" && e.answered === null;
    const text = answers[e.id] ?? "";
    return (
      <li key={e.id} className="squad-escalation" data-open={open ? "true" : undefined}>
        <div className="task-row">
          <strong>{t("squads.fromTo", { from: t(`squads.role.${e.from}`), to: t(`squads.target.${e.to}`) })}</strong>
          <span className="doc-subtitle">{t(age.key, age.vars)}</span>
        </div>
        <p className="squad-question">{e.question}</p>
        {e.answer !== null && <p className="doc-subtitle">{t("squads.answered", { answer: e.answer })}</p>}
        {open && (
          <form
            className="task-row"
            onSubmit={async (ev) => {
              ev.preventDefault();
              if (await act(v.squad.id, "answer", () => api.answerSquad(v.squad.id, e.id, text))) setAnswers((a) => ({ ...a, [e.id]: "" }));
            }}
          >
            <input
              className="squad-answer"
              aria-label={t("squads.answer")}
              placeholder={t("squads.answerHint")}
              value={text}
              onChange={(ev) => setAnswers((a) => ({ ...a, [e.id]: ev.target.value }))}
            />
            <Button type="submit" style={COMPACT} disabled={text.trim() === "" || v.squad.id in pending}>
              {t("squads.answer")}
            </Button>
          </form>
        )}
      </li>
    );
  }

  function eventLine(e: SquadEvent, i: number, now: number) {
    const age = relativeTime(now, e.at);
    return (
      <li key={`${e.at}-${i}`} className="squad-event">
        <span className="doc-subtitle">{t(age.key, age.vars)}</span>
        {e.role && <span className="badge">{t(`squads.role.${e.role}`)}</span>}
        <span className="squad-event-kind" data-kind={e.kind}>{EVENT_KINDS.has(e.kind) ? t(`squads.event.${e.kind}`) : e.kind}</span>
        {e.text && <span className="squad-event-text">{e.text}</span>}
      </li>
    );
  }

  function page(v: View) {
    const now = nowSec();
    const s = status(v.squad.id, v.status);
    const busy = v.squad.id in pending;
    const seatsNow = ROLES.map((r) => seatState(v, r));
    const working = seatsNow.filter((x) => x.state === "working").length;
    const vacant = v.squad.seats.filter((x) => x.account === null).length;
    const violations = v.run?.violations ?? 0;
    const escalations = v.run?.escalations ?? [];
    const open = escalations.filter((e) => e.answered === null).length;
    const started = v.run ? relativeTime(now, v.run.started) : null;
    const events = allEvents ?? v.events;
    const canRun = s === "idle" || s === "done" || s === "stopped";
    return (
      <section className="squad-page" aria-label={v.squad.name}>
        <div className="squad-main">
          <div className="doc-titles">
            <h2 className="task-goal">{v.squad.name}</h2>
            <span className="doc-subtitle">
              {[t("squads.hierarchy"), folder(v.squad.repo), started && t("squads.started", { when: t(started.key, started.vars) })]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <div className="task-row squad-chips">
            <span className="squad-chip" data-kind="active">{t("squads.active", { count: working })}</span>
            <span className="squad-chip" data-kind="vacant">{t("squads.vacantCount", { count: vacant })}</span>
            <span className="squad-chip" data-kind="violations" data-some={violations > 0 ? "true" : undefined}>
              {t("squads.violations", { count: violations })}
            </span>
            <span className="badge squad-state" data-state={s}>
              {t(`squads.state.${s}`)}
            </span>
          </div>

          {v.run && <p className="squad-goal">{v.run.goal}</p>}
          <div className="task-row squad-controls">
            {canRun && (
              <form
                className="task-row squad-goal-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await act(v.squad.id, "run", () => api.runSquad(v.squad.id, goal))) setGoal("");
                }}
              >
                <input aria-label={t("tasks.goal")} placeholder={t("squads.goalHint")} value={goal} onChange={(e) => setGoal(e.target.value)} disabled={busy} />
                <Button type="submit" style={COMPACT} disabled={busy || goal.trim() === ""}>
                  {t("tasks.runAction")}
                </Button>
              </form>
            )}
            {(s === "stopped" || s === "waiting") && (
              <Button type="button" style={COMPACT} disabled={busy} onClick={() => void act(v.squad.id, "resume", () => api.resumeSquad(v.squad.id))}>
                {t("tasks.resume")}
              </Button>
            )}
            {(s === "running" || s === "waiting") && (
              <button type="button" className="btn-secondary squad-stop" onClick={() => setConfirming(true)}>
                {t("squads.stop")}
              </button>
            )}
            {v.run && onOpenTask && (
              <button type="button" className="btn-secondary" onClick={() => onOpenTask(v.run!.task)}>
                {t("squads.openTask")}
              </button>
            )}
          </div>
          {s === "running" && (
            <p className="task-working" role="status">
              {t("squads.working")}
            </p>
          )}

          <div className="squad-card">
            <div className="task-row squad-card-head">
              <h3 className="squad-card-title">{t("squads.seats")}</h3>
              <span className="squad-tag">{t("squads.hierarchy")}</span>
            </div>
            <div className="squad-tree" aria-label={t("squads.seats")}>
              <div className="squad-tree-lead">{seatButton(v, "lead")}</div>
              <div className="squad-tree-implement">{seatButton(v, "implement")}</div>
              <div className="squad-tree-review">{seatButton(v, "review")}</div>
              <div className="squad-tree-tests">{seatButton(v, "tests")}</div>
            </div>
            <p className="doc-subtitle">{t("squads.ringHint")}</p>
          </div>

          <div className="squad-pair">
          <section className="squad-card" aria-label={t("squads.escalations")}>
            <h3 className="squad-card-title">{t("squads.escalationsCount", { count: open })}</h3>
            {escalations.length === 0 ? (
              <p className="pane-empty">{t("squads.noEscalations")}</p>
            ) : (
              <ul className="squad-list">{escalations.map((e) => escalation(v, e, now))}</ul>
            )}
          </section>

          <section className="squad-card" aria-label={t("squads.recent")}>
            <div className="task-row">
              <h3 className="squad-card-title">{t(allEvents ? "squads.activity" : "squads.recent")}</h3>
              {allEvents === null && v.eventCount > v.events.length && (
                <button type="button" className="btn-secondary" onClick={() => void showAll(v.squad.id)}>
                  {t("squads.activity")}
                </button>
              )}
            </div>
            {events.length === 0 ? (
              <p className="pane-empty">{t("squads.noEvents")}</p>
            ) : (
              <ol className="squad-list squad-events">{[...events].reverse().map((e, i) => eventLine(e, i, now))}</ol>
            )}
          </section>
          </div>
          <div className="task-row">
            <button
              type="button"
              className="btn-secondary squad-remove"
              disabled={busy || s === "running"}
              onClick={() => void act(v.squad.id, "remove", () => api.removeSquad(v.squad.id)).then((ok) => ok && setSelected(null))}
            >
              {t("squads.remove")}
            </button>
          </div>
        </div>
        {sheet && seatSheet(v, sheet)}
      </section>
    );
  }

  return (
    <div className="tasks-view squads-view">
      <div className="agentctx-head">
        <div className="doc-titles">
          <h1 className="doc-title">{t("squads.title")}</h1>
          <span className="doc-subtitle">{t("squads.subtitle")}</span>
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
            {t("squads.new")}
          </Button>
        </div>
      </div>
      {problem && note(problem)}
      {creating && form()}
      {items === undefined ? (
        !problem && <p className="placeholder">{t("squads.loading")}</p>
      ) : items.length === 0 ? (
        !creating && <p className="placeholder">{t("squads.empty")}</p>
      ) : (
        <div className="tasks-body">
          <ul className="task-list" aria-label={t("squads.title")}>
            {items.map((x) => (
              <li key={x.squad.id}>
                <button type="button" className="task-item" aria-current={x.squad.id === current ? "true" : undefined} onClick={() => select(x.squad.id)}>
                  <span className="squad-item-text">
                    <span className="task-item-goal">{x.squad.name}</span>
                    <span className="doc-subtitle">{folder(x.squad.repo)}</span>
                  </span>
                  <span className="badge squad-state" data-state={status(x.squad.id, x.status)}>
                    {t(`squads.state.${status(x.squad.id, x.status)}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {shown ? page(shown) : <p className="placeholder">{t("squads.loading")}</p>}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={t("squads.confirmStop.title")}
        body={t("squads.confirmStop.body")}
        confirmLabel={t("squads.stop")}
        onConfirm={() => {
          setConfirming(false);
          if (shown) void quick(() => api.stopSquad(shown.squad.id));
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
