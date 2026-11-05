//! The worker sweeper. Auto-close: once a worker is finished, its tab closes
//! after a quiet spell, unless it is kept, busy again, or the setting is off.
//! Failover: a worker that fails before it finishes is restarted or replaced,
//! as the orchestration settings say.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use xdev_orch::failover::{self, Choice, Policy, Seen, Situation};
use xdev_orch::{FailReason, FailoverKind, OrchError, StartResult, Store, Worker};

use crate::cli_verbs::TabReport;
use crate::commands::AppState;
use crate::orchestration::{
    OrchHub, READY_DEFAULT_MS, WorkerChanged, WorkerClose, WorkerOpen, WorkerOpenOutcome,
};
use crate::settings::OrchestrationSettings;

/// How often the sweeper looks.
pub const TICK: Duration = Duration::from_secs(1);

/// The store key of the time auto-close was turned on.
const SINCE_KEY: &str = "auto_close_since_ms";

/// When auto-close was last turned on, so a worker that finished while it
/// was off keeps its tab. The time is kept in the store, so a restart with
/// the setting on does not forget it.
#[derive(Debug, Default)]
pub struct AutoClose {
    was_on: Option<bool>,
    since_ms: Option<i64>,
}

impl AutoClose {
    /// With the setting `on` at `now_ms`: none when off, else the time it
    /// was turned on (0 when it was on from the start). `load` reads the
    /// kept time (once, when the app starts); `save` keeps a new one, or
    /// forgets it (none) while the setting is off.
    pub fn since(
        &mut self,
        on: bool,
        now_ms: i64,
        load: &dyn Fn() -> Option<i64>,
        save: &dyn Fn(Option<i64>),
    ) -> Option<i64> {
        let was = self.was_on.replace(on);
        if !on {
            if was != Some(false) {
                save(None);
            }
            self.since_ms = None;
            return None;
        }
        if was == Some(false) {
            self.since_ms = Some(now_ms);
            save(Some(now_ms));
        }
        Some(*self.since_ms.get_or_insert_with(|| load().unwrap_or(0)))
    }
}

/// One pass over workers that finished from `since_ms` on. `emit` sends the UI its events: `close-worker` for a tab that is
/// due, `worker-changed` for every strip that changed. How many tabs it asked
/// to close.
pub fn sweep_once(
    hub: &OrchHub,
    data: &Path,
    since_ms: i64,
    tabs: &[TabReport],
    now_ms: i64,
    emit: &dyn Fn(&str, Value),
) -> usize {
    let status_of = |tab: &str| {
        tabs.iter().find(|t| t.id == tab).map(|t| {
            if t.exited {
                "exited".to_owned()
            } else {
                t.status.clone()
            }
        })
    };
    let Ok(swept) = hub.with_store(data, |s| s.worker_sweep(&status_of, since_ms, now_ms)) else {
        return 0;
    };
    let mut closed = 0;
    for w in swept {
        if w.close {
            closed += 1;
            if let Ok(p) = serde_json::to_value(WorkerClose {
                dispatch: w.dispatch.clone(),
                tab: w.tab.clone(),
            }) {
                emit("orchestration://close-worker", p);
            }
        }
        if let Ok(p) = serde_json::to_value(WorkerChanged { tab: w.tab }) {
            emit("orchestration://worker-changed", p);
        }
    }
    closed
}

/// Starts the sweeper thread; it ticks every second. Auto-close runs while
/// its setting is on, failover while failover or autopilot is. The settings
/// are read once and then kept fresh by the settings command.
pub fn start(app: AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || {
        let mut auto = AutoClose::default();
        let mut watch = Watch::default();
        loop {
            std::thread::sleep(TICK);
            let hub = app.state::<OrchHub>();
            let settings = remembered(|| crate::settings_store::read(&app).orchestration);
            let on = hub.auto_close(|| settings.worker_auto_close);
            let now = crate::workspace::clock().0;
            let state = app.state::<AppState>();
            let Ok(data) = crate::accounts::data_dir(&state) else {
                continue;
            };
            let has_db = data.join("orchestration.db").is_file();
            let load = || {
                if !has_db {
                    return None;
                }
                hub.with_store(data, |s| s.meta_get(SINCE_KEY))
                    .ok()
                    .flatten()
            };
            let save = |v: Option<i64>| {
                if has_db {
                    let _ = hub.with_store(data, |s| s.meta_set(SINCE_KEY, v));
                }
            };
            let since = auto.since(on, now, &load, &save);
            if !has_db {
                continue;
            }
            let board = app.state::<crate::cli_verbs::CliHub>();
            let (tabs, _) = board.board.tabs();
            let emit = |event: &str, payload: Value| {
                let _ = app.emit(event, payload);
            };
            if let Some(since) = since {
                sweep_once(&hub, data, since, &tabs, now, &emit);
            }
            let tails = app.state::<crate::term_tail::TermTails>();
            let env = AppEnv {
                tails: &tails,
                data,
            };
            let jobs = failover_once(&hub, data, &mut watch, &tabs, &settings, &env, now, &emit);
            for job in jobs {
                let app = app.clone();
                let data = data.to_path_buf();
                // The open waits on the UI; the sweeper keeps ticking.
                std::thread::spawn(move || {
                    let hub = app.state::<OrchHub>();
                    let emit = |event: &str, payload: Value| {
                        let _ = app.emit(event, payload);
                    };
                    start_job(&hub, &data, &job, &emit, &|| crate::workspace::clock().0);
                });
            }
        }
    });
}

/// Emitted with a [`WorkerFailover`] once per failover, restart or failed
/// worker.
pub const FAILOVER_EVENT: &str = "orchestration://failover";

/// The lines of a tab's output read for markers.
const MARKER_LINES: usize = 40;
/// The lines of a tab's output read for the next worker's preamble.
const TAIL_LINES: usize = 400;

/// Payload of `orchestration://failover`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkerFailover {
    pub task: String,
    /// The failed worker.
    pub from_dispatch: String,
    pub from_tab: String,
    pub from_agent: String,
    pub reason: FailReason,
    /// Restart or failover; none when the worker was marked failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub kind: Option<FailoverKind>,
    /// The worker that took over, when one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub dispatch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub tab: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub account: Option<String>,
}

/// What the strip over a worker that took over from a failed one shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FailedOver {
    pub from_agent: String,
    pub reason: FailReason,
    pub kind: FailoverKind,
    /// The account this worker was started on, when xDev chose it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub account: Option<String>,
}

/// What the failover pass needs from outside the store.
pub trait FailEnv {
    /// The last `lines` lines tab `tab` printed; empty when none.
    fn output(&self, tab: &str, lines: usize) -> String;
    /// How full account `name`'s tightest quota window is, in percent.
    fn quota_used(&self, name: &str) -> Option<f64>;
    /// Another account of `provider` than `current`, by its routing.
    fn backup_account(&self, provider: &str, current: &str) -> Option<String>;
}

/// What the failover pass remembers between ticks.
#[derive(Debug, Default)]
pub struct Watch {
    /// When each stuck worker was first seen stuck, by dispatch.
    stuck_since: HashMap<String, i64>,
}

/// A worker to open for a failed one; the store already has it.
#[derive(Debug, Clone)]
pub struct Job {
    pub open: WorkerOpen,
    pub event: WorkerFailover,
    /// Close the failed worker's tab: it is stuck, so still running.
    pub close_old: bool,
}

/// The failover settings, as [`failover::choose`] reads them.
pub fn policy_of(s: &OrchestrationSettings) -> Policy {
    Policy {
        enabled: s.failover_enabled,
        backup_account: s.failover_backup_account,
        backup_agents: s.failover_backup_agents.clone(),
        max_failovers: s.failover_max,
        autopilot: s.autopilot_restart,
    }
}

/// Why the worker in `tab` failed, or none. A busy worker can only be stuck
/// (autopilot only); the output and quota are read once it stops.
fn reason_of(
    w: &Worker,
    tab: &TabReport,
    settings: &OrchestrationSettings,
    env: &dyn FailEnv,
    now_ms: i64,
) -> Option<FailReason> {
    if !tab.exited && tab.status == "working" {
        let after = i64::from(settings.stuck_minutes) * 60_000;
        let quiet = (tab.last_output_ms > 0).then_some(tab.last_output_ms);
        return (settings.autopilot_restart && failover::stuck(true, quiet, now_ms, after))
            .then_some(FailReason::Stuck);
    }
    if !settings.failover_enabled {
        return None;
    }
    let output = env.output(&tab.id, MARKER_LINES);
    let quota_used = tab.account.as_deref().and_then(|a| env.quota_used(a));
    failover::detect(
        w.state,
        &Seen {
            exited: tab.exited,
            exit_code: tab.exit_code,
            output: &output,
            provider: tab.cli.as_deref(),
            quota_used,
        },
    )
}

/// One pass over the ready workers: each that failed is left, marked failed,
/// or taken over in the store. Returns the workers to open; `emit` has
/// already told the UI about the ones marked failed.
#[allow(clippy::too_many_arguments)]
pub fn failover_once(
    hub: &OrchHub,
    data: &Path,
    watch: &mut Watch,
    tabs: &[TabReport],
    settings: &OrchestrationSettings,
    env: &dyn FailEnv,
    now_ms: i64,
    emit: &dyn Fn(&str, Value),
) -> Vec<Job> {
    let policy = policy_of(settings);
    if !policy.enabled && !policy.autopilot {
        watch.stuck_since.clear();
        return Vec::new();
    }
    let Ok(workers) = hub.with_store(data, Store::ready_workers) else {
        return Vec::new();
    };
    let mut stuck = Vec::new();
    let mut jobs = Vec::new();
    for w in workers {
        // A tab gone from the board was closed by the person: left alone.
        let Some(tab) = w
            .tab
            .as_deref()
            .and_then(|id| tabs.iter().find(|t| t.id == id))
        else {
            continue;
        };
        let Some(reason) = reason_of(&w, tab, settings, env, now_ms) else {
            continue;
        };
        let mut stuck_for = 0;
        if reason == FailReason::Stuck {
            stuck.push(w.dispatch_id.clone());
            let since = *watch
                .stuck_since
                .entry(w.dispatch_id.clone())
                .or_insert(now_ms);
            stuck_for = now_ms - since;
        }
        let acted = hub.with_store(data, |s| {
            act(
                s, &w, tab, reason, stuck_for, settings, &policy, env, now_ms,
            )
        });
        match acted {
            Ok(Acted::Job(job)) => jobs.push(*job),
            Ok(Acted::Failed(event)) => {
                if let Ok(p) = serde_json::to_value(&event) {
                    emit(FAILOVER_EVENT, p);
                }
                if let Ok(p) = serde_json::to_value(WorkerChanged {
                    tab: tab.id.clone(),
                }) {
                    emit("orchestration://worker-changed", p);
                }
            }
            Ok(Acted::Nothing) | Err(_) => {}
        }
    }
    watch.stuck_since.retain(|d, _| stuck.contains(d));
    jobs
}

enum Acted {
    Nothing,
    Failed(WorkerFailover),
    Job(Box<Job>),
}

/// Applies the policy's choice for failed worker `w` in the store.
#[allow(clippy::too_many_arguments)]
fn act(
    s: &Store,
    w: &Worker,
    tab: &TabReport,
    reason: FailReason,
    stuck_for_ms: i64,
    settings: &OrchestrationSettings,
    policy: &Policy,
    env: &dyn FailEnv,
    now_ms: i64,
) -> Result<Acted, OrchError> {
    let chain = s.failover_history(&w.dispatch_id)?;
    let backup = match (
        policy.backup_account,
        tab.cli.as_deref(),
        tab.account.as_deref(),
    ) {
        (true, Some(provider), Some(current)) => env
            .backup_account(provider, current)
            .filter(|a| !chain.accounts.contains(a)),
        _ => None,
    };
    let choice = failover::choose(
        policy,
        &Situation {
            reason,
            state: w.state,
            agent: &w.agent,
            failovers: chain.failovers,
            restarts: chain.restarts,
            tried_agents: &chain.agents,
            backup_account: backup.as_deref(),
            stuck_for_ms,
        },
    );
    let old = s.dispatch_get(&w.dispatch_id)?;
    let mut event = WorkerFailover {
        task: old.task_id.clone(),
        from_dispatch: old.id.clone(),
        from_tab: tab.id.clone(),
        from_agent: w.agent.clone(),
        reason,
        kind: None,
        dispatch: None,
        tab: None,
        agent: None,
        account: None,
    };
    let (kind, agent, account) = match choice {
        Choice::Leave | Choice::Wait => return Ok(Acted::Nothing),
        Choice::MarkFailed => {
            s.worker_fail(&w.dispatch_id, reason, settings.worker_auto_close, now_ms)?;
            s.worker_failover_notice(&w.dispatch_id, None, reason, now_ms)?;
            return Ok(Acted::Failed(event));
        }
        Choice::Restart => (FailoverKind::Restart, w.agent.clone(), tab.account.clone()),
        Choice::FailOver { agent, account } => (FailoverKind::Failover, agent, account),
    };
    let task = s.task_get(&old.task_id)?;
    let next_tab = s.next_id("tab");
    let plan = xdev_orch::StartPlan {
        run_id: old.run_id.clone(),
        task_id: old.task_id.clone(),
        parent_dispatch: old.parent_dispatch.clone(),
        depth: old.depth,
        retry_of: None,
        tab: next_tab.clone(),
        worktree: w.worktree.clone(),
        agent: agent.clone(),
        kept: false,
    };
    let takeover = xdev_orch::Takeover {
        of: w.dispatch_id.clone(),
        reason,
        kind,
        account: account.clone(),
    };
    let next = s.worker_take_over(&takeover, &plan, settings.worker_auto_close, now_ms)?;
    let output = env.output(&tab.id, TAIL_LINES);
    let preamble = xdev_orch::build_preamble(&xdev_orch::PreambleInput {
        run: &old.run_id,
        task: &task.id,
        dispatch: &next.id,
        spec: &task.spec,
        depth: old.depth,
        max_depth: settings.nested_worker_max_depth,
        cli: "xdev",
    })?;
    let prompt = format!(
        "{}\n\n{preamble}",
        failover::continue_preamble(&w.agent, reason, &output)
    );
    event.kind = Some(kind);
    event.dispatch = Some(next.id.clone());
    event.tab = Some(next_tab.clone());
    event.agent = Some(agent.clone());
    event.account.clone_from(&account);
    Ok(Acted::Job(Box::new(Job {
        open: WorkerOpen {
            dispatch: next.id,
            tab: next_tab,
            title: format!("worker-{}", task.id),
            worktree: w.worktree.clone(),
            profile: agent,
            prompt,
            setup: "skip".to_owned(),
            ready_timeout_ms: READY_DEFAULT_MS,
            account,
        },
        event,
        close_old: reason == FailReason::Stuck,
    })))
}

/// Opens the worker of `job` and waits for the UI, then records the start,
/// leaves a note in the run's mail and tells the UI.
pub fn start_job(
    hub: &OrchHub,
    data: &Path,
    job: &Job,
    emit: &dyn Fn(&str, Value),
    clock: &dyn Fn() -> i64,
) {
    if job.close_old
        && let Ok(p) = serde_json::to_value(WorkerClose {
            dispatch: job.event.from_dispatch.clone(),
            tab: job.event.from_tab.clone(),
        })
    {
        emit("orchestration://close-worker", p);
    }
    let result = match serde_json::to_value(&job.open) {
        Ok(payload) => {
            let wait = Duration::from_millis(job.open.ready_timeout_ms) + hub.waits.open_slack;
            match hub.opens.ask(
                job.open.dispatch.clone(),
                || emit("orchestration://open-worker", payload),
                wait,
            ) {
                Some(WorkerOpenOutcome::Ok) => StartResult::Ready,
                Some(WorkerOpenOutcome::Failed { stage, error }) => {
                    StartResult::Failed { stage, error }
                }
                None => StartResult::Unknown,
            }
        }
        Err(e) => StartResult::Failed {
            stage: xdev_orch::FailedStage::TerminalCreate,
            error: e.to_string(),
        },
    };
    let _ = hub.with_store(data, |s| {
        let now = clock();
        s.worker_started(&job.open.dispatch, result, now)?;
        s.worker_failover_notice(
            &job.event.from_dispatch,
            Some(&job.open.dispatch),
            job.event.reason,
            now,
        )
    });
    if let Ok(p) = serde_json::to_value(&job.event) {
        emit(FAILOVER_EVENT, p);
    }
    for tab in [&job.event.from_tab, &job.open.tab] {
        if let Ok(p) = serde_json::to_value(WorkerChanged { tab: tab.clone() }) {
            emit("orchestration://worker-changed", p);
        }
    }
}

/// The worker in `tab` took over from a failed one: from what, and why.
pub fn failed_over(hub: &OrchHub, data: &Path, tab: &str) -> Option<FailedOver> {
    hub.with_store(data, |s| {
        let Some(w) = s.worker_of_tab(tab)? else {
            return Ok(None);
        };
        let d = s.dispatch_get(&w.dispatch_id)?;
        let (Some(of), Some(reason), Some(kind)) =
            (d.failover_of, d.failover_reason, d.failover_kind)
        else {
            return Ok(None);
        };
        Ok(Some(FailedOver {
            from_agent: s.worker_get(&of)?.agent,
            reason,
            kind,
            account: d.account,
        }))
    })
    .ok()
    .flatten()
}

/// The strip's failover line for the worker in `tab`; none when it took
/// over from no one.
#[tauri::command(async)]
pub fn orchestration_worker_failover(
    state: tauri::State<'_, AppState>,
    hub: tauri::State<'_, OrchHub>,
    tab: String,
) -> Option<FailedOver> {
    let data = crate::accounts::data_dir(&state).ok()?;
    failed_over(&hub, data, &tab)
}

/// The orchestration settings as last stored; kept fresh by the settings
/// command, so the sweeper does not read the file every tick.
static SETTINGS: Mutex<Option<OrchestrationSettings>> = Mutex::new(None);

/// Called by the settings command with what it stored.
pub fn remember(settings: &OrchestrationSettings) {
    *SETTINGS.lock().unwrap_or_else(PoisonError::into_inner) = Some(settings.clone());
}

fn remembered(load: impl FnOnce() -> OrchestrationSettings) -> OrchestrationSettings {
    SETTINGS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(load)
        .clone()
}

/// The app's side of [`FailEnv`].
struct AppEnv<'a> {
    tails: &'a crate::term_tail::TermTails,
    data: &'a Path,
}

impl FailEnv for AppEnv<'_> {
    fn output(&self, tab: &str, lines: usize) -> String {
        self.tails
            .read(tab, None, lines)
            .map(|r| r.text)
            .unwrap_or_default()
    }

    fn quota_used(&self, name: &str) -> Option<f64> {
        crate::accounts::used(name)
    }

    fn backup_account(&self, provider: &str, current: &str) -> Option<String> {
        let provider = xdev_ai::Provider::parse(provider).ok()?;
        let registry = xdev_ai::Registry::load(self.data).ok()?;
        crate::accounts::backup(&registry, provider, current)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn tab(id: &str, status: &str) -> TabReport {
        TabReport {
            id: id.to_owned(),
            worktree: "/wt".to_owned(),
            title: None,
            profile: "claude".to_owned(),
            agent: true,
            status: status.to_owned(),
            last_output_ms: 0,
            exited: false,
            cli: None,
            account: None,
            exit_code: None,
        }
    }

    #[test]
    fn auto_close_counts_from_when_it_was_turned_on() {
        let kept = std::cell::Cell::new(None);
        let load = || kept.get();
        let save = |v: Option<i64>| kept.set(v);
        let mut a = AutoClose::default();
        // On from the start: every finished worker counts.
        assert_eq!(a.since(true, 1_000, &load, &save), Some(0));
        assert_eq!(a.since(true, 2_000, &load, &save), Some(0));
        assert_eq!(a.since(false, 3_000, &load, &save), None);
        assert_eq!(kept.get(), None);
        // Turned on again: only workers that finish from now on.
        assert_eq!(a.since(true, 4_000, &load, &save), Some(4_000));
        assert_eq!(a.since(true, 5_000, &load, &save), Some(4_000));
        assert_eq!(kept.get(), Some(4_000));
        // A restart with the setting still on: the kept time is read back.
        let mut b = AutoClose::default();
        assert_eq!(b.since(true, 9_000, &load, &save), Some(4_000));
        // A restart with it off forgets the time.
        let mut c = AutoClose::default();
        assert_eq!(c.since(false, 9_500, &load, &save), None);
        assert_eq!(kept.get(), None);
    }

    #[test]
    fn a_finished_workers_tab_closes_after_the_quiet_spell_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let hub = OrchHub::default();
        let d = hub
            .with_store(dir.path(), |s| {
                let run = s.run_create("o", Some("lead"), 1)?;
                let t = s.task_create(
                    &run.id,
                    xdev_orch::NewTask {
                        title: None,
                        spec: "x".into(),
                        deps: vec![],
                        parent: None,
                    },
                    1,
                )?;
                let d = s.worker_begin(
                    &xdev_orch::StartPlan {
                        run_id: run.id.clone(),
                        task_id: t.id,
                        parent_dispatch: None,
                        depth: 1,
                        retry_of: None,
                        tab: "t1".into(),
                        worktree: "/wt".into(),
                        agent: "claude".into(),
                        kept: false,
                    },
                    1,
                )?;
                s.worker_started(&d.id, xdev_orch::StartResult::Ready, 2)?;
                s.worker_settle(&d.id, xdev_orch::WorkerState::Succeeded, None, true, 1_000)?;
                Ok(d.id)
            })
            .unwrap();
        let events = Mutex::new(Vec::<(String, Value)>::new());
        let emit = |e: &str, p: Value| events.lock().unwrap().push((e.to_owned(), p));
        let idle = [tab("t1", "idle")];
        let due = 1_000 + xdev_orch::CLOSE_AFTER_MS;
        assert_eq!(sweep_once(&hub, dir.path(), 0, &idle, due - 1, &emit), 0);
        assert!(events.lock().unwrap().is_empty());
        // Working again cancels; the strip is told.
        let busy = [tab("t1", "working")];
        sweep_once(&hub, dir.path(), 0, &busy, due - 1, &emit);
        assert_eq!(
            events.lock().unwrap()[0].0,
            "orchestration://worker-changed"
        );
        // Quiet, then due.
        sweep_once(&hub, dir.path(), 0, &idle, 5_000, &emit);
        let n = sweep_once(
            &hub,
            dir.path(),
            0,
            &idle,
            5_000 + xdev_orch::CLOSE_AFTER_MS,
            &emit,
        );
        assert_eq!(n, 1);
        let seen = events.lock().unwrap().clone();
        let close = seen
            .iter()
            .find(|(e, _)| e == "orchestration://close-worker")
            .unwrap();
        assert_eq!(close.1["dispatch"], d);
        assert_eq!(close.1["tab"], "t1");
        // Released once the tab has left the board; never again.
        let gone = 5_000 + xdev_orch::CLOSE_AFTER_MS + 1;
        assert_eq!(sweep_once(&hub, dir.path(), 0, &[], gone, &emit), 0);
        let released = hub
            .with_store(dir.path(), |s| s.worker_get(&d))
            .unwrap()
            .released;
        assert!(released);
        assert_eq!(sweep_once(&hub, dir.path(), 0, &idle, 99_999_999, &emit), 0);
    }

    /// The outside world of the failover pass, faked.
    #[derive(Default)]
    struct FakeEnv {
        output: HashMap<String, String>,
        quota: HashMap<String, f64>,
        backup: Option<String>,
    }

    impl FailEnv for FakeEnv {
        fn output(&self, tab: &str, _lines: usize) -> String {
            self.output.get(tab).cloned().unwrap_or_default()
        }

        fn quota_used(&self, name: &str) -> Option<f64> {
            self.quota.get(name).copied()
        }

        fn backup_account(&self, _provider: &str, current: &str) -> Option<String> {
            self.backup.clone().filter(|b| b != current)
        }
    }

    /// A ready worker of a new task, in tab `tab`, running `agent`.
    fn ready_worker(hub: &OrchHub, data: &Path, tab: &str, agent: &str) -> String {
        hub.with_store(data, |s| {
            let run = s.run_create("o", Some("lead"), 1)?;
            let t = s.task_create(
                &run.id,
                xdev_orch::NewTask {
                    title: None,
                    spec: "fix the parser".into(),
                    deps: vec![],
                    parent: None,
                },
                1,
            )?;
            let d = s.worker_begin(
                &xdev_orch::StartPlan {
                    run_id: run.id.clone(),
                    task_id: t.id,
                    parent_dispatch: None,
                    depth: 1,
                    retry_of: None,
                    tab: tab.into(),
                    worktree: "/wt".into(),
                    agent: agent.into(),
                    kept: false,
                },
                1,
            )?;
            s.worker_started(&d.id, StartResult::Ready, 2)?;
            Ok(d.id)
        })
        .unwrap()
    }

    fn agent_tab(id: &str, status: &str, cli: &str, account: Option<&str>) -> TabReport {
        TabReport {
            cli: Some(cli.to_owned()),
            account: account.map(str::to_owned),
            ..tab(id, status)
        }
    }

    fn exited(t: TabReport, code: Option<i32>) -> TabReport {
        TabReport {
            exited: true,
            exit_code: code,
            ..t
        }
    }

    fn on(agents: &[&str]) -> OrchestrationSettings {
        OrchestrationSettings {
            failover_enabled: true,
            failover_backup_agents: agents.iter().map(|a| (*a).to_owned()).collect(),
            ..OrchestrationSettings::default()
        }
    }

    type Events = Mutex<Vec<(String, Value)>>;

    /// `emit` for a fake UI that opens every worker it is asked to.
    fn ui<'a>(hub: &'a OrchHub, events: &'a Events) -> impl Fn(&str, Value) + 'a {
        move |e: &str, p: Value| {
            if e == "orchestration://open-worker" {
                let id = p["dispatch"].as_str().unwrap_or_default().to_owned();
                hub.opens.answer(&id, WorkerOpenOutcome::Ok);
            }
            events.lock().unwrap().push((e.to_owned(), p));
        }
    }

    fn named(events: &Events, name: &str) -> Vec<Value> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == name)
            .map(|(_, p)| p.clone())
            .collect()
    }

    #[test]
    fn a_failed_worker_fails_over_to_the_backup_agent_with_the_last_output() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let hub = OrchHub::default();
        let d = ready_worker(&hub, data, "t1", "claude");
        let events = Events::default();
        let emit = ui(&hub, &events);
        let env = FakeEnv {
            output: HashMap::from([("t1".to_owned(), "panic: index out of range".to_owned())]),
            ..FakeEnv::default()
        };
        let mut watch = Watch::default();
        let crashed = [exited(agent_tab("t1", "idle", "claude", None), Some(1))];

        // Off by default: nothing happens.
        let off = OrchestrationSettings::default();
        let jobs = failover_once(&hub, data, &mut watch, &crashed, &off, &env, 10, &emit);
        assert!(jobs.is_empty());

        let settings = on(&["codex"]);
        let jobs = failover_once(&hub, data, &mut watch, &crashed, &settings, &env, 10, &emit);
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(job.open.profile, "codex");
        assert_eq!(job.open.account, None);
        assert!(!job.close_old);
        assert!(job.open.prompt.contains("panic: index out of range"));
        assert!(job.open.prompt.contains("fix the parser"));
        assert_eq!(job.event.kind, Some(FailoverKind::Failover));
        assert_eq!(job.event.reason, FailReason::Exited);
        // Taken over in the store at once: the next pass does not repeat it.
        let again = failover_once(&hub, data, &mut watch, &crashed, &settings, &env, 11, &emit);
        assert!(again.is_empty());

        start_job(&hub, data, job, &emit, &|| 20);
        let opened = named(&events, "orchestration://open-worker");
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0]["profile"], "codex");
        let told = named(&events, FAILOVER_EVENT);
        assert_eq!(told.len(), 1);
        assert_eq!(told[0]["fromAgent"], "claude");
        assert_eq!(told[0]["reason"], "exited");
        assert_eq!(told[0]["kind"], "failover");
        let (old, new) = hub
            .with_store(data, |s| {
                Ok((s.worker_get(&d)?, s.worker_get(&job.open.dispatch)?))
            })
            .unwrap();
        assert_eq!(old.state, xdev_orch::WorkerState::Failed);
        assert_eq!(new.state, xdev_orch::WorkerState::Ready);
        let line = failed_over(&hub, data, &job.open.tab).unwrap();
        assert_eq!(line.from_agent, "claude");
        assert_eq!(line.reason, FailReason::Exited);
        assert_eq!(failed_over(&hub, data, "t1"), None);

        // The backup fails too and no agent is left: marked failed, once.
        let both = [
            crashed[0].clone(),
            exited(agent_tab(&job.open.tab, "idle", "codex", None), None),
        ];
        let jobs = failover_once(&hub, data, &mut watch, &both, &settings, &env, 30, &emit);
        assert!(jobs.is_empty());
        let told = named(&events, FAILOVER_EVENT);
        assert_eq!(told.len(), 2);
        assert_eq!(told[1]["reason"], "crashed");
        assert!(told[1].get("kind").is_none());
        let last = hub
            .with_store(data, |s| s.worker_get(&job.open.dispatch))
            .unwrap();
        assert_eq!(last.state, xdev_orch::WorkerState::Failed);
    }

    #[test]
    fn out_of_quota_moves_to_another_account_and_a_closed_tab_is_left() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let hub = OrchHub::default();
        ready_worker(&hub, data, "t1", "claude");
        let gone = ready_worker(&hub, data, "t2", "claude");
        let events = Events::default();
        let emit = ui(&hub, &events);
        let env = FakeEnv {
            output: HashMap::from([
                ("t1".to_owned(), "Claude usage limit reached.".to_owned()),
                ("t2".to_owned(), "Claude usage limit reached.".to_owned()),
            ]),
            backup: Some("work".to_owned()),
            ..FakeEnv::default()
        };
        let mut watch = Watch::default();
        // t2 is not on the board: the person closed it.
        let board = [agent_tab("t1", "idle", "claude", Some("home"))];
        let settings = on(&[]);
        let jobs = failover_once(&hub, data, &mut watch, &board, &settings, &env, 10, &emit);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].open.profile, "claude");
        assert_eq!(jobs[0].open.account.as_deref(), Some("work"));
        assert_eq!(jobs[0].event.reason, FailReason::OutOfQuota);
        let left = hub.with_store(data, |s| s.worker_get(&gone)).unwrap();
        assert_eq!(left.state, xdev_orch::WorkerState::Ready);

        // A quota that reads full counts too; still working, it does not.
        ready_worker(&hub, data, "t3", "codex");
        let env = FakeEnv {
            quota: HashMap::from([("home".to_owned(), 100.0)]),
            ..FakeEnv::default()
        };
        let busy = [agent_tab("t3", "working", "codex", Some("home"))];
        let none = failover_once(
            &hub,
            data,
            &mut watch,
            &busy,
            &on(&["claude"]),
            &env,
            10,
            &emit,
        );
        assert!(none.is_empty());
        let idle = [agent_tab("t3", "idle", "codex", Some("home"))];
        let jobs = failover_once(
            &hub,
            data,
            &mut watch,
            &idle,
            &on(&["claude"]),
            &env,
            10,
            &emit,
        );
        assert_eq!(jobs[0].event.reason, FailReason::QuotaFull);
        assert_eq!(jobs[0].open.profile, "claude");
    }

    #[test]
    fn a_stuck_worker_restarts_after_the_backoff_then_fails() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let hub = OrchHub::default();
        ready_worker(&hub, data, "t1", "claude");
        let events = Events::default();
        let emit = ui(&hub, &events);
        let env = FakeEnv::default();
        let mut watch = Watch::default();
        let settings = OrchestrationSettings {
            autopilot_restart: true,
            stuck_minutes: 1,
            ..OrchestrationSettings::default()
        };
        let quiet = TabReport {
            last_output_ms: 1_000,
            ..agent_tab("t1", "working", "claude", Some("home"))
        };
        let stuck_at = 1_000 + 60_000;
        let run = |watch: &mut Watch, tabs: &[TabReport], now| {
            failover_once(&hub, data, watch, tabs, &settings, &env, now, &emit)
        };
        // Not quiet long enough, then stuck: it waits out the backoff.
        assert!(run(&mut watch, std::slice::from_ref(&quiet), stuck_at - 1).is_empty());
        assert!(run(&mut watch, std::slice::from_ref(&quiet), stuck_at).is_empty());
        let back = xdev_orch::failover::RESTART_BACKOFF_MS[0];
        assert!(
            run(
                &mut watch,
                std::slice::from_ref(&quiet),
                stuck_at + back - 1
            )
            .is_empty()
        );
        let jobs = run(&mut watch, std::slice::from_ref(&quiet), stuck_at + back);
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(job.event.kind, Some(FailoverKind::Restart));
        assert_eq!(job.open.profile, "claude");
        assert_eq!(job.open.account.as_deref(), Some("home"));
        assert!(job.close_old);
        start_job(&hub, data, job, &emit, &|| stuck_at + back);
        let closed = named(&events, "orchestration://close-worker");
        assert_eq!(closed[0]["tab"], "t1");

        // Stuck again: the longer backoff, then failed (failover is off).
        let t = job.open.tab.clone();
        let again = TabReport {
            id: t.clone(),
            ..quiet.clone()
        };
        let later = stuck_at + back + 60_000;
        assert!(run(&mut watch, std::slice::from_ref(&again), later).is_empty());
        let back2 = xdev_orch::failover::RESTART_BACKOFF_MS[1];
        assert!(run(&mut watch, std::slice::from_ref(&again), later + back2 - 1).is_empty());
        assert!(run(&mut watch, std::slice::from_ref(&again), later + back2).is_empty());
        let w = hub
            .with_store(data, |s| s.worker_get(&job.open.dispatch))
            .unwrap();
        assert_eq!(w.state, xdev_orch::WorkerState::Failed);
        assert_eq!(named(&events, FAILOVER_EVENT).len(), 2);
    }
}
