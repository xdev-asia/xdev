//! Automations in the app: the managed service the commands (and, later, the CLI endpoint)
//! share, the 60 s tick thread, and the events that ask the UI to open a tab. The UI owns
//! tabs, so a dispatch is an event and the outcome comes back as a command.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use xdev_automations::precheck::ShellLine;
use xdev_automations::tick::{TickStep, Watch};
use xdev_automations::{
    Automation, AutomationInput, AutomationRun, DEFAULT_TICK_MS, Describe, FailureCode,
    OutputSnapshot, RunPatch, RunStatus, RunTrigger, SNAPSHOT_MAX_LINES, SetupDecision, Store,
    StoreError, WorkspaceMode, occur, parse_extra_args, precheck, schedule, store::workspace_name,
};

use crate::commands::CmdError;

pub const DISPATCH_EVENT: &str = "automation://dispatch";
pub const CHANGED_EVENT: &str = "automations://changed";

/// What the UI needs to start one run.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutomationDispatch {
    pub run_id: String,
    pub automation_id: String,
    pub worktree: String,
    pub repo_id: String,
    /// The worktree was made for this run.
    pub created: bool,
    pub setup: SetupDecision,
    pub profile: String,
    pub prompt: String,
    pub extra_args: Vec<String>,
    /// The previous run's tab, when the automation reuses its session.
    pub reuse_tab: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutomationsChanged {
    pub automation_id: Option<String>,
}

/// The UI's report of a launch. `NeedsApproval` maps to `skipped_needs_interactive_auth`.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum DispatchResult {
    #[serde(rename_all = "camelCase")]
    Dispatched { run_id: String, tab_id: String },
    #[serde(rename_all = "camelCase")]
    Failed {
        run_id: String,
        code: FailureCode,
        detail: Option<String>,
    },
}

/// The UI's report of the end of a run.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunFinish {
    pub run_id: String,
    pub completed: bool,
    pub output: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutomationsView {
    pub automations: Vec<Automation>,
    /// The newest run of each automation that has one.
    pub last_runs: Vec<AutomationRun>,
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
type Params = std::collections::BTreeMap<String, String>;

fn cmd_error(code: &'static str, detail: impl Into<Option<String>>) -> CmdError {
    CmdError {
        code,
        detail: detail.into(),
    }
}

fn from_store(e: StoreError) -> CmdError {
    match e {
        StoreError::NotFound => cmd_error("not_found", None),
        StoreError::InvalidSchedule => cmd_error("invalid_schedule", None),
        StoreError::ExtraArgs(e) => cmd_error("extra_args", serde_json::to_string(&e).ok()),
        StoreError::Io(e) => cmd_error("io", e.to_string()),
        StoreError::Json(e) => cmd_error("io", e.to_string()),
    }
}

fn save(store: &Store) -> Result<(), CmdError> {
    store.save().map_err(from_store)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn patch(status: RunStatus, at: i64) -> RunPatch {
    RunPatch {
        status,
        worktree: None,
        worktree_name: None,
        tab_id: None,
        output_snapshot: None,
        precheck_result: None,
        failure: None,
        at,
    }
}

fn failed(status: RunStatus, code: FailureCode, params: Params, at: i64) -> RunPatch {
    RunPatch {
        failure: Some((code, params)),
        ..patch(status, at)
    }
}

fn detail_params(detail: Option<&str>) -> Params {
    let mut params = Params::new();
    if let Some(d) = detail {
        params.insert("detail".into(), d.into());
    }
    params
}

/// The last `SNAPSHOT_MAX_LINES` lines, and whether any were cut.
fn clip_lines(text: &str) -> (String, bool) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= SNAPSHOT_MAX_LINES {
        return (text.to_owned(), false);
    }
    (lines[lines.len() - SNAPSHOT_MAX_LINES..].join("\n"), true)
}

/// The key of the copy the editor shows for a schedule that cannot be saved; `None` when it can.
pub(crate) fn schedule_error_key(expr: &str, tz: &str, now: i64) -> Option<&'static str> {
    use xdev_automations::ScheduleError as E;
    match schedule::parse(
        expr,
        xdev_automations::ParseOptions {
            reject_oversized_step: true,
        },
    ) {
        Err(E::TooLong) => Some("tooLong"),
        Err(E::Step { .. }) => Some("step"),
        Err(_) => Some("invalid"),
        Ok(_) if schedule::is_valid_new(expr, tz, now) => None,
        Ok(_) => Some("noDate"),
    }
}

/// Shared by the commands and, later, the endpoint's `automation.*` arms.
///
/// The store is behind one mutex that is never held across a precheck, a worktree creation or an
/// event: the tick takes it to read and write, lets go to do the slow part, and takes it again.
pub struct AutomationService {
    store: Mutex<Store>,
    ui_ready: AtomicBool,
    evaluating: AtomicBool,
    clock: Clock,
}

/// What the tick needs from the app; a fake in tests.
pub trait DispatchEnv {
    fn now(&self) -> i64;
    fn precheck_line(&self, cwd: &Path, command: &str) -> Result<ShellLine, CmdError>;
    fn repo_path(&self, repo_id: &str) -> Option<PathBuf>;
    fn worktree_exists(&self, path: &str) -> bool;
    /// Returns the new worktree's `(path, name)`.
    fn create_worktree(
        &self,
        repo_id: &str,
        name: &str,
        from: Option<&str>,
    ) -> Result<(String, String), CmdError>;
    /// `None` is no such or a disabled profile; `Some(None)` is a custom shell profile.
    fn profile_cli(&self, profile: &str) -> Option<Option<xdev_agent::Cli>>;
    fn emit_dispatch(&self, d: &AutomationDispatch);
    fn emit_changed(&self, c: &AutomationsChanged);
}

/// Clears `evaluating` when a tick ends, however it ends.
struct Evaluating<'a>(&'a AtomicBool);

impl Drop for Evaluating<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl AutomationService {
    pub fn new(store: Store, clock: impl Fn() -> i64 + Send + Sync + 'static) -> AutomationService {
        AutomationService {
            store: Mutex::new(store),
            ui_ready: AtomicBool::new(false),
            evaluating: AtomicBool::new(false),
            clock: Box::new(clock),
        }
    }

    /// Opens `automations.json` in `data_dir` and settles the runs a quit left open.
    pub fn open(data_dir: &Path) -> AutomationService {
        let store = Store::open(data_dir).unwrap_or_else(|e| {
            eprintln!("automations store: {e}");
            Store::open(&std::env::temp_dir().join("xdev-automations-unreadable"))
                .expect("a missing file is an empty store")
        });
        let service = AutomationService::new(store, || crate::workspace::clock().0);
        service.reconcile_startup();
        service
    }

    fn store(&self) -> MutexGuard<'_, Store> {
        // The guard protects no invariant across a panic: every write is saved whole.
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Runs that were `dispatching` or `dispatched` when the app quit will never report: they
    /// end as `agentInterrupted`.
    pub fn reconcile_startup(&self) {
        let now = self.now();
        let mut store = self.store();
        let open: Vec<String> = store
            .list()
            .iter()
            .flat_map(|a| store.runs(&a.id))
            .filter(|r| matches!(r.status, RunStatus::Dispatching | RunStatus::Dispatched))
            .map(|r| r.id)
            .collect();
        for id in &open {
            let _ = store.update_run(
                id,
                failed(
                    RunStatus::DispatchFailed,
                    FailureCode::AgentInterrupted,
                    Params::new(),
                    now,
                ),
            );
        }
        if !open.is_empty() {
            let _ = save(&store);
        }
    }

    pub fn list(&self) -> AutomationsView {
        let store = self.store();
        let last_runs = store
            .list()
            .iter()
            .filter_map(|a| store.runs(&a.id).into_iter().next())
            .collect();
        AutomationsView {
            automations: store.list().to_vec(),
            last_runs,
        }
    }

    pub fn get_runs(&self, automation_id: &str) -> Vec<AutomationRun> {
        self.store().runs(automation_id)
    }

    pub fn create(&self, input: AutomationInput) -> Result<Automation, CmdError> {
        let now = self.now();
        let mut store = self.store();
        let made = store.create(input, now, new_id()).map_err(from_store)?;
        save(&store)?;
        Ok(made)
    }

    pub fn update(&self, id: &str, input: AutomationInput) -> Result<Automation, CmdError> {
        let now = self.now();
        let mut store = self.store();
        let made = store.update(id, input, now).map_err(from_store)?;
        save(&store)?;
        Ok(made)
    }

    pub fn set_enabled(&self, id: &str, on: bool) -> Result<Automation, CmdError> {
        let now = self.now();
        let mut store = self.store();
        let made = store.set_enabled(id, on, now).map_err(from_store)?;
        save(&store)?;
        Ok(made)
    }

    pub fn delete(&self, id: &str) -> Result<(), CmdError> {
        let mut store = self.store();
        store.delete(id).map_err(from_store)?;
        save(&store)
    }

    /// Queues a manual run, paused or not; the next tick starts it.
    pub fn run_now(&self, id: &str) -> Result<AutomationRun, CmdError> {
        let now = self.now();
        let mut store = self.store();
        let a = store
            .list()
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or_else(|| cmd_error("not_found", None))?;
        // Runs of one automation do not overlap.
        if store.runs(id).iter().any(|r| !r.status.is_final()) {
            return Err(cmd_error("bad_arg", Some("previousRunActive".into())));
        }
        let run = store.create_run(&a, now, RunTrigger::Manual, now, new_id());
        save(&store)?;
        Ok(run)
    }

    pub fn is_ready(&self) -> bool {
        self.ui_ready.load(Ordering::Acquire)
    }

    pub fn set_ready(&self, ready: bool) {
        self.ui_ready.store(ready, Ordering::Release);
    }

    /// One evaluation pass: settle open runs the watchdog gives up on, decide what is due, then
    /// start every queued run. A pass that is already running makes this one return at once.
    pub fn tick(&self, env: &dyn DispatchEnv) {
        if self.evaluating.swap(true, Ordering::AcqRel) {
            return;
        }
        let _evaluating = Evaluating(&self.evaluating);
        let now = env.now();
        let ready = self.is_ready();
        let queued = {
            let mut store = self.store();
            let mut touched = false;
            let open: Vec<AutomationRun> = store
                .list()
                .iter()
                .flat_map(|a| store.runs(&a.id))
                .filter(|r| !r.status.is_final())
                .collect();
            for run in &open {
                if let Watch::Fail(code) = xdev_automations::tick::watchdog(run, now) {
                    let _ = store.update_run(
                        &run.id,
                        failed(RunStatus::DispatchFailed, code, Params::new(), now),
                    );
                    touched = true;
                }
            }
            // Open runs left after the watchdog: their automations wait for them to end.
            let busy: Vec<String> = store
                .list()
                .iter()
                .filter(|a| store.runs(&a.id).iter().any(|r| !r.status.is_final()))
                .map(|a| a.id.clone())
                .collect();
            let busy: Vec<&str> = busy.iter().map(String::as_str).collect();
            let steps =
                xdev_automations::tick::plan(store.list(), now, DEFAULT_TICK_MS, ready, &busy);
            touched |= !steps.is_empty();
            for step in steps {
                self.carry_out(&mut store, step, now);
            }
            if touched && let Err(e) = save(&store) {
                eprintln!("automations save: {}", e.code);
            }
            let mut queued: Vec<AutomationRun> = store
                .list()
                .iter()
                .flat_map(|a| store.runs(&a.id))
                .filter(|r| r.status == RunStatus::Pending)
                .collect();
            queued.sort_by_key(|r| (r.created_at, r.run_number));
            if touched {
                env.emit_changed(&AutomationsChanged {
                    automation_id: None,
                });
            }
            queued
        };
        if !ready {
            return;
        }
        for run in queued {
            if let Some(automation_id) = self.dispatch(env, &run.id) {
                env.emit_changed(&AutomationsChanged {
                    automation_id: Some(automation_id),
                });
            }
        }
    }

    /// One step of the plan, under the store lock; slow work waits for `dispatch`.
    fn carry_out(&self, store: &mut Store, step: TickStep, now: i64) {
        let find = |store: &Store, id: &str| store.list().iter().find(|a| a.id == id).cloned();
        match step {
            TickStep::Advance { id } => {
                let _ = store.advance(&id, now);
            }
            TickStep::Missed { id, scheduled_for } => {
                let Some(a) = find(store, &id) else { return };
                let run = store.create_run(&a, scheduled_for, RunTrigger::Scheduled, now, new_id());
                let _ = store.update_run(
                    &run.id,
                    failed(
                        RunStatus::SkippedMissed,
                        FailureCode::MissedGraceWindow,
                        Params::new(),
                        now,
                    ),
                );
                let _ = store.advance(&id, now);
            }
            TickStep::Unevaluable { id, detail } => {
                let Some(a) = find(store, &id) else { return };
                let mut params = Params::new();
                params.insert("detail".into(), detail);
                self.skip(
                    store,
                    &a,
                    a.next_run_at,
                    FailureCode::UnevaluableSchedule,
                    params,
                    now,
                );
                let _ = store.advance(&id, now);
            }
            TickStep::Refuse {
                id,
                scheduled_for,
                code,
            } => {
                let Some(a) = find(store, &id) else { return };
                self.skip(store, &a, scheduled_for, code, Params::new(), now);
                let _ = store.advance(&id, now);
            }
            TickStep::Dispatch { id, scheduled_for } => {
                let Some(a) = find(store, &id) else { return };
                store.create_run(&a, scheduled_for, RunTrigger::Scheduled, now, new_id());
                let _ = store.advance(&id, now);
            }
        }
    }

    /// A refusal: folded into the last identical one, else a new `skipped_unavailable` run.
    fn skip(
        &self,
        store: &mut Store,
        a: &Automation,
        scheduled_for: i64,
        code: FailureCode,
        params: Params,
        now: i64,
    ) {
        let error = code.english(&params);
        if store.repeat_skip(&a.id, &error, scheduled_for).is_some() {
            return;
        }
        let run = store.create_run(a, scheduled_for, RunTrigger::Scheduled, now, new_id());
        let _ = store.update_run(
            &run.id,
            failed(RunStatus::SkippedUnavailable, code, params, now),
        );
    }

    /// Ends the run with `patch`; the automation's id when it changed.
    fn settle(&self, run_id: &str, patch: RunPatch) -> Option<String> {
        let mut store = self.store();
        let run = store.update_run(run_id, patch).ok()?;
        if let Err(e) = save(&store) {
            eprintln!("automations save: {}", e.code);
        }
        Some(run.automation_id)
    }

    /// Starts one queued run: checks its target, runs the precheck, makes the worktree, and asks
    /// the UI for a tab. Nothing here holds the store lock while it waits.
    fn dispatch(&self, env: &dyn DispatchEnv, run_id: &str) -> Option<String> {
        let now = env.now();
        let (a, run, reuse_tab) = {
            let mut store = self.store();
            let run = store
                .run(run_id)
                .filter(|r| r.status == RunStatus::Pending)?
                .clone();
            let a = store
                .list()
                .iter()
                .find(|a| a.id == run.automation_id)?
                .clone();
            let reuse_tab = if a.reuse_session && a.workspace_mode == WorkspaceMode::Existing {
                store
                    .runs(&a.id)
                    .into_iter()
                    .find(|r| r.id != run.id && r.tab_id.is_some())
                    .and_then(|r| r.tab_id)
            } else {
                None
            };
            store
                .update_run(run_id, patch(RunStatus::Dispatching, now))
                .ok()?;
            let _ = save(&store);
            (a, run, reuse_tab)
        };
        let end =
            |status, code, params| self.settle(run_id, failed(status, code, params, env.now()));

        let cwd = match a.workspace_mode {
            WorkspaceMode::Existing => match a.worktree.as_deref() {
                Some(path) if env.worktree_exists(path) => PathBuf::from(path),
                _ => {
                    return end(
                        RunStatus::SkippedUnavailable,
                        FailureCode::TargetUnavailable,
                        Params::new(),
                    );
                }
            },
            WorkspaceMode::NewPerRun => match env.repo_path(&a.repo_id) {
                Some(path) => path,
                None => {
                    return end(
                        RunStatus::SkippedUnavailable,
                        FailureCode::RepoUnavailable,
                        Params::new(),
                    );
                }
            },
        };
        let Some(cli) = env.profile_cli(&a.agent) else {
            return end(
                RunStatus::DispatchFailed,
                FailureCode::AutomationChanged,
                Params::new(),
            );
        };
        let extra_args = match parse_extra_args(cli, a.extra_agent_args.as_deref().unwrap_or("")) {
            Ok(args) => args,
            Err(e) => {
                return end(
                    RunStatus::DispatchFailed,
                    FailureCode::AutomationChanged,
                    detail_params(serde_json::to_string(&e).ok().as_deref()),
                );
            }
        };

        if let Some(check) = &a.precheck {
            let mut result = match env.precheck_line(&cwd, &check.command) {
                Ok(line) => precheck::run(
                    &line,
                    &cwd,
                    Duration::from_secs(u64::from(check.timeout_seconds)),
                    &|| env.now(),
                ),
                Err(e) => {
                    let mut params = Params::new();
                    params.insert("error".into(), e.detail.unwrap_or_else(|| e.code.into()));
                    return end(
                        RunStatus::SkippedPrecheck,
                        FailureCode::PrecheckFailed,
                        params,
                    );
                }
            };
            result.command.clone_from(&check.command);
            if !precheck::passed(&result) {
                let (code, params) = precheck::failure(&result);
                return self.settle(
                    run_id,
                    RunPatch {
                        precheck_result: Some(result),
                        ..failed(RunStatus::SkippedPrecheck, code, params, env.now())
                    },
                );
            }
        }

        let (path, name, created) = match a.workspace_mode {
            WorkspaceMode::Existing => {
                let path = cwd.to_string_lossy().into_owned();
                let name = cwd
                    .file_name()
                    .map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
                (path, name, false)
            }
            WorkspaceMode::NewPerRun => {
                let name = workspace_name(&run.title, run.scheduled_for);
                match env.create_worktree(&a.repo_id, &name, a.base_branch.as_deref()) {
                    Ok((path, name)) => (path, name, true),
                    Err(e) => {
                        return end(
                            RunStatus::DispatchFailed,
                            FailureCode::WorktreeCreateFailed,
                            detail_params(Some(&e.detail.unwrap_or_else(|| e.code.into()))),
                        );
                    }
                }
            }
        };
        let id = self.settle(
            run_id,
            RunPatch {
                worktree: Some(path.clone()),
                worktree_name: Some(name),
                ..patch(RunStatus::Dispatching, env.now())
            },
        )?;
        env.emit_dispatch(&AutomationDispatch {
            run_id: run_id.to_owned(),
            automation_id: a.id.clone(),
            worktree: path,
            repo_id: a.repo_id.clone(),
            created,
            setup: a.setup_decision,
            profile: a.agent.clone(),
            prompt: a.prompt.clone(),
            extra_args,
            reuse_tab,
        });
        Some(id)
    }

    /// The UI's report of a launch. Only a run still starting takes it; a second report is ignored.
    pub fn dispatch_result(&self, result: DispatchResult) -> Option<String> {
        let now = self.now();
        let run_id = match &result {
            DispatchResult::Dispatched { run_id, .. } | DispatchResult::Failed { run_id, .. } => {
                run_id.clone()
            }
        };
        let mut store = self.store();
        // A launched run can still fail on one report: its agent never started working.
        let never_started = matches!(
            &result,
            DispatchResult::Failed {
                code: FailureCode::AgentNeverStarted,
                ..
            }
        );
        let open = store.run(&run_id).is_some_and(|r| match r.status {
            RunStatus::Pending | RunStatus::Dispatching => true,
            RunStatus::Dispatched => never_started,
            _ => false,
        });
        if !open {
            return None;
        }
        let change = match result {
            DispatchResult::Dispatched { tab_id, .. } => RunPatch {
                tab_id: Some(tab_id),
                ..patch(RunStatus::Dispatched, now)
            },
            DispatchResult::Failed { code, detail, .. } => {
                let status = if code == FailureCode::NeedsApproval {
                    RunStatus::SkippedNeedsInteractiveAuth
                } else {
                    RunStatus::DispatchFailed
                };
                failed(status, code, detail_params(detail.as_deref()), now)
            }
        };
        let run = store.update_run(&run_id, change).ok()?;
        let _ = save(&store);
        Some(run.automation_id)
    }

    /// The UI's report of the end of a run: `done` is a completed run, anything else did not finish.
    pub fn run_finish(&self, finish: RunFinish) -> Option<String> {
        let now = self.now();
        let mut store = self.store();
        let open = store
            .run(&finish.run_id)
            .is_some_and(|r| matches!(r.status, RunStatus::Dispatching | RunStatus::Dispatched));
        if !open {
            return None;
        }
        let snapshot = finish.output.as_deref().map(|text| {
            let (content, cut) = clip_lines(text);
            OutputSnapshot {
                content,
                captured_at: now,
                truncated: finish.truncated || cut,
            }
        });
        let change = RunPatch {
            output_snapshot: snapshot,
            ..if finish.completed {
                patch(RunStatus::Completed, now)
            } else {
                failed(
                    RunStatus::DispatchFailed,
                    FailureCode::AgentNoCompletion,
                    Params::new(),
                    now,
                )
            }
        };
        let run = store.update_run(&finish.run_id, change).ok()?;
        let _ = save(&store);
        Some(run.automation_id)
    }
}

/// The tick thread's two switches: `kick` asks for a pass now, `stop` ends the thread.
#[derive(Default)]
pub struct TickControl {
    kick: AtomicBool,
    stop: AtomicBool,
}

/// The real environment of a tick: the app's profiles, repos, shells and events.
struct AppEnv {
    app: AppHandle,
}

impl AppEnv {
    fn data(&self) -> Result<PathBuf, CmdError> {
        use tauri::Manager;
        self.app
            .state::<crate::commands::AppState>()
            .data_dir
            .clone()
            .ok_or(CmdError {
                code: "bad_arg",
                detail: Some("no data folder".into()),
            })
    }
}

impl DispatchEnv for AppEnv {
    fn now(&self) -> i64 {
        crate::workspace::clock().0
    }

    fn precheck_line(&self, cwd: &Path, command: &str) -> Result<ShellLine, CmdError> {
        let line = crate::pty::shell_line(&self.data()?, cwd, command)?;
        Ok(ShellLine {
            program: line.program,
            args: line.args,
            env: line.env,
        })
    }

    fn repo_path(&self, repo_id: &str) -> Option<PathBuf> {
        let reg = xdev_workspace::Registry::load(&self.data().ok()?).ok()?;
        reg.repos
            .iter()
            .find(|r| r.id == repo_id)
            .map(|r| r.path.clone())
    }

    fn worktree_exists(&self, path: &str) -> bool {
        Path::new(path).is_dir()
    }

    fn create_worktree(
        &self,
        repo_id: &str,
        name: &str,
        from: Option<&str>,
    ) -> Result<(String, String), CmdError> {
        let view = crate::workspace::create_for_automation(&self.app, repo_id, name, from)?;
        Ok((view.path, view.name))
    }

    fn profile_cli(&self, profile: &str) -> Option<Option<xdev_agent::Cli>> {
        let profiles = xdev_agent::Profiles::load(&self.data().ok()?).ok()?;
        profiles.get(profile).filter(|p| p.enabled).map(|p| p.cli)
    }

    fn emit_dispatch(&self, d: &AutomationDispatch) {
        use tauri::Emitter;
        let _ = self.app.emit(DISPATCH_EVENT, d);
    }

    fn emit_changed(&self, c: &AutomationsChanged) {
        use tauri::Emitter;
        let _ = self.app.emit(CHANGED_EVENT, c);
    }
}

fn control(app: &AppHandle) -> Option<tauri::State<'_, TickControl>> {
    use tauri::Manager;
    app.try_state::<TickControl>()
}

/// Asks the tick thread for a pass now (after a save, or when the UI is ready).
fn kick(app: &AppHandle) {
    if let Some(c) = control(app) {
        c.kick.store(true, Ordering::Release);
    }
}

fn announce(app: &AppHandle, automation_id: Option<String>) {
    use tauri::Emitter;
    let _ = app.emit(CHANGED_EVENT, AutomationsChanged { automation_id });
    kick(app);
}

/// Starts the tick thread: a pass every `DEFAULT_TICK_MS` and one whenever it is kicked. It looks at
/// the clock in 1 s slices, so `stop` ends it within a second (or when the pass in hand ends).
pub fn start(app: &AppHandle) {
    use tauri::Manager;
    app.manage(TickControl::default());
    let app = app.clone();
    std::thread::spawn(move || {
        let env = AppEnv { app: app.clone() };
        let mut waited_ms = 0_i64;
        loop {
            let Some(c) = control(&app) else { return };
            if c.stop.load(Ordering::Acquire) {
                return;
            }
            let kicked = c.kick.swap(false, Ordering::AcqRel);
            if kicked || waited_ms >= DEFAULT_TICK_MS {
                waited_ms = 0;
                if let Some(service) = app.try_state::<AutomationService>() {
                    // A panic in one pass must not end the schedule for good.
                    let pass = std::panic::AssertUnwindSafe(|| service.tick(&env));
                    if std::panic::catch_unwind(pass).is_err() {
                        eprintln!("automations: a tick panicked");
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(1));
            waited_ms += 1_000;
        }
    });
}

/// Ends the tick thread at quit.
pub fn stop(app: &AppHandle) {
    if let Some(c) = control(app) {
        c.stop.store(true, Ordering::Release);
    }
}

/// The window is gone: nothing can open a tab until the UI says it is ready again.
pub fn window_gone(app: &AppHandle) {
    use tauri::Manager;
    if let Some(service) = app.try_state::<AutomationService>() {
        service.set_ready(false);
    }
}

fn service(app: &AppHandle) -> Result<tauri::State<'_, AutomationService>, CmdError> {
    use tauri::Manager;
    app.try_state::<AutomationService>().ok_or(CmdError {
        code: "bad_arg",
        detail: Some("no data folder".into()),
    })
}

/// The extras of `input` checked against its agent's CLI, so the editor hears of a bad list at
/// save time. An agent that is not (or no longer) listed is left to the dispatch.
fn check_extras(app: &AppHandle, input: &AutomationInput) -> Result<(), CmdError> {
    let Some(text) = input
        .extra_agent_args
        .as_deref()
        .filter(|t| !t.trim().is_empty())
    else {
        return Ok(());
    };
    let env = AppEnv { app: app.clone() };
    let Some(cli) = env.profile_cli(&input.agent) else {
        return Ok(());
    };
    parse_extra_args(cli, text)
        .map(|_| ())
        .map_err(|e| cmd_error("extra_args", serde_json::to_string(&e).ok()))
}

#[tauri::command(async)]
pub fn automations_list(app: AppHandle) -> Result<AutomationsView, CmdError> {
    Ok(service(&app)?.list())
}

#[tauri::command(async)]
pub fn automation_runs(
    app: AppHandle,
    automation_id: String,
) -> Result<Vec<AutomationRun>, CmdError> {
    Ok(service(&app)?.get_runs(&automation_id))
}

#[tauri::command(async)]
pub fn automation_create(app: AppHandle, input: AutomationInput) -> Result<Automation, CmdError> {
    check_extras(&app, &input)?;
    let made = service(&app)?.create(input)?;
    announce(&app, Some(made.id.clone()));
    Ok(made)
}

#[tauri::command(async)]
pub fn automation_update(
    app: AppHandle,
    id: String,
    input: AutomationInput,
) -> Result<Automation, CmdError> {
    check_extras(&app, &input)?;
    let made = service(&app)?.update(&id, input)?;
    announce(&app, Some(made.id.clone()));
    Ok(made)
}

#[tauri::command(async)]
pub fn automation_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Automation, CmdError> {
    let made = service(&app)?.set_enabled(&id, enabled)?;
    announce(&app, Some(made.id.clone()));
    Ok(made)
}

#[tauri::command(async)]
pub fn automation_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    service(&app)?.delete(&id)?;
    announce(&app, Some(id));
    Ok(())
}

#[tauri::command(async)]
pub fn automation_run_now(app: AppHandle, id: String) -> Result<AutomationRun, CmdError> {
    let run = service(&app)?.run_now(&id)?;
    announce(&app, Some(run.automation_id.clone()));
    Ok(run)
}

#[tauri::command(async)]
pub fn automation_describe(expr: String, timezone: String) -> Describe {
    xdev_automations::schedule::describe(&expr, &timezone, crate::workspace::clock().0)
}

/// The error copy key of a schedule that cannot be saved, or `None` when it can.
#[tauri::command(async)]
pub fn automation_validate_schedule(expr: String, timezone: String) -> Option<String> {
    schedule_error_key(&expr, &timezone, crate::workspace::clock().0).map(str::to_owned)
}

/// The next `count` (at most 5) occurrences from `dtstart`, for the editor preview.
#[tauri::command(async)]
pub fn automation_next_runs(
    expr: String,
    timezone: String,
    dtstart: i64,
    count: usize,
) -> Vec<i64> {
    let mut after = dtstart.max(crate::workspace::clock().0) - 1;
    let mut out = Vec::new();
    for _ in 0..count.min(5) {
        match occur::next_after(&expr, &timezone, dtstart, after) {
            Ok(next) => {
                out.push(next);
                after = next;
            }
            Err(_) => break,
        }
    }
    out
}

#[tauri::command(async)]
pub fn automation_ui_ready(app: AppHandle) -> Result<(), CmdError> {
    service(&app)?.set_ready(true);
    kick(&app);
    Ok(())
}

#[tauri::command(async)]
pub fn automation_dispatch_result(app: AppHandle, result: DispatchResult) -> Result<(), CmdError> {
    if let Some(id) = service(&app)?.dispatch_result(result) {
        announce(&app, Some(id));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn automation_run_finish(app: AppHandle, finish: RunFinish) -> Result<(), CmdError> {
    if let Some(id) = service(&app)?.run_finish(finish) {
        announce(&app, Some(id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicI64;

    use xdev_agent::Cli;
    use xdev_automations::{Precheck, PrecheckResult};

    use super::*;

    /// 2026-11-05T10:00:00Z, an hour mark.
    const T0: i64 = 1_793_872_800_000;
    const MIN: i64 = 60_000;

    struct Fake {
        now: Arc<AtomicI64>,
        worktrees: Vec<String>,
        repo: Option<PathBuf>,
        profile: Option<Option<Cli>>,
        create: Result<(String, String), CmdError>,
        dispatched: Mutex<Vec<AutomationDispatch>>,
        changed: Mutex<Vec<Option<String>>>,
        created: Mutex<Vec<(String, String, Option<String>)>>,
        prechecked_in: Mutex<Vec<PathBuf>>,
    }

    impl Fake {
        fn new(now: &Arc<AtomicI64>) -> Fake {
            Fake {
                now: now.clone(),
                worktrees: vec!["/wt/main".into()],
                repo: Some(std::env::temp_dir()),
                profile: Some(Some(Cli::Claude)),
                create: Ok(("/wt/auto".into(), "auto".into())),
                dispatched: Mutex::new(Vec::new()),
                changed: Mutex::new(Vec::new()),
                created: Mutex::new(Vec::new()),
                prechecked_in: Mutex::new(Vec::new()),
            }
        }
        fn sent(&self) -> Vec<AutomationDispatch> {
            self.dispatched.lock().unwrap().clone()
        }
    }

    impl DispatchEnv for Fake {
        fn now(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
        fn precheck_line(&self, cwd: &Path, command: &str) -> Result<ShellLine, CmdError> {
            self.prechecked_in.lock().unwrap().push(cwd.to_owned());
            Ok(ShellLine {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), command.into()],
                env: vec![],
            })
        }
        fn repo_path(&self, _repo_id: &str) -> Option<PathBuf> {
            self.repo.clone()
        }
        fn worktree_exists(&self, path: &str) -> bool {
            self.worktrees.iter().any(|w| w == path)
        }
        fn create_worktree(
            &self,
            repo_id: &str,
            name: &str,
            from: Option<&str>,
        ) -> Result<(String, String), CmdError> {
            self.created.lock().unwrap().push((
                repo_id.into(),
                name.into(),
                from.map(str::to_owned),
            ));
            match &self.create {
                Ok(v) => Ok(v.clone()),
                Err(e) => Err(CmdError {
                    code: e.code,
                    detail: e.detail.clone(),
                }),
            }
        }
        fn profile_cli(&self, _profile: &str) -> Option<Option<Cli>> {
            self.profile
        }
        fn emit_dispatch(&self, d: &AutomationDispatch) {
            self.dispatched.lock().unwrap().push(d.clone());
        }
        fn emit_changed(&self, c: &AutomationsChanged) {
            self.changed.lock().unwrap().push(c.automation_id.clone());
        }
    }

    struct Rig {
        _dir: tempfile::TempDir,
        clock: Arc<AtomicI64>,
        service: AutomationService,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(T0 - 30 * MIN));
        let c = clock.clone();
        let service = AutomationService::new(Store::open(dir.path()).unwrap(), move || {
            c.load(Ordering::SeqCst)
        });
        Rig {
            _dir: dir,
            clock,
            service,
        }
    }

    fn input() -> AutomationInput {
        AutomationInput {
            name: "Audit".into(),
            prompt: "Look around.".into(),
            precheck: None,
            agent: "claude".into(),
            extra_agent_args: None,
            repo_id: "repo".into(),
            workspace_mode: WorkspaceMode::Existing,
            worktree: Some("/wt/main".into()),
            base_branch: None,
            setup_decision: SetupDecision::Inherit,
            reuse_session: false,
            timezone: "UTC".into(),
            rrule: "FREQ=HOURLY;BYMINUTE=0".into(),
            dtstart: T0 - 30 * MIN,
            enabled: true,
            missed_run_grace_minutes: 720,
        }
    }

    impl Rig {
        fn at(&self, ms: i64) {
            self.clock.store(ms, Ordering::SeqCst);
        }
        fn ready(&self) {
            self.service.set_ready(true);
        }
        /// The first run of `id` after a tick one minute past the hour.
        fn tick_due(&self, env: &Fake) {
            self.at(T0 + MIN);
            self.service.tick(env);
        }
        fn runs(&self, id: &str) -> Vec<AutomationRun> {
            self.service.get_runs(id)
        }
    }

    #[test]
    #[cfg(unix)]
    fn an_existing_worktree_runs_the_precheck_there_then_asks_the_ui() {
        let r = rig();
        r.ready();
        let wt = tempfile::tempdir().unwrap();
        let path = wt
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut env = Fake::new(&r.clock);
        env.worktrees = vec![path.clone()];
        let a = r
            .service
            .create(AutomationInput {
                worktree: Some(path.clone()),
                // Passes only when it runs inside the worktree.
                precheck: Some(Precheck {
                    command: format!("test \"$(pwd -P)\" = '{path}'"),
                    timeout_seconds: 10,
                }),
                extra_agent_args: Some("--model opus".into()),
                ..input()
            })
            .unwrap();
        r.tick_due(&env);
        let sent = env.sent();
        assert_eq!(sent.len(), 1);
        let d = &sent[0];
        assert_eq!(
            (d.worktree.as_str(), d.created, d.profile.as_str()),
            (path.as_str(), false, "claude")
        );
        assert_eq!(
            (
                d.prompt.as_str(),
                d.automation_id.as_str(),
                d.reuse_tab.clone()
            ),
            ("Look around.", a.id.as_str(), None)
        );
        assert_eq!(d.extra_args, ["--model", "opus"]);
        assert_eq!(d.setup, SetupDecision::Inherit);
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::Dispatching);
        assert_eq!(
            (run.scheduled_for, run.trigger),
            (T0, RunTrigger::Scheduled)
        );
        assert_eq!(run.worktree.as_deref(), Some(path.as_str()));
        assert_eq!(run.id, d.run_id);
        // The next occurrence is armed.
        assert_eq!(r.service.list().automations[0].next_run_at, T0 + 60 * MIN);
        assert!(env.changed.lock().unwrap().contains(&Some(a.id.clone())));
    }

    #[test]
    fn a_missing_worktree_is_unavailable() {
        let r = rig();
        r.ready();
        let mut env = Fake::new(&r.clock);
        env.worktrees.clear();
        let a = r.service.create(input()).unwrap();
        r.tick_due(&env);
        assert!(env.sent().is_empty());
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::SkippedUnavailable);
        assert_eq!(run.error_code, Some(FailureCode::TargetUnavailable));
    }

    #[test]
    #[cfg(unix)]
    fn a_new_run_per_tick_gets_its_own_worktree_after_the_precheck_in_the_repo() {
        let r = rig();
        r.ready();
        let repo = tempfile::tempdir().unwrap();
        let mut env = Fake::new(&r.clock);
        env.repo = Some(repo.path().to_owned());
        let a = r
            .service
            .create(AutomationInput {
                workspace_mode: WorkspaceMode::NewPerRun,
                worktree: None,
                base_branch: Some("develop".into()),
                setup_decision: SetupDecision::Run,
                precheck: Some(Precheck {
                    command: "true".into(),
                    timeout_seconds: 10,
                }),
                ..input()
            })
            .unwrap();
        r.tick_due(&env);
        assert_eq!(
            *env.prechecked_in.lock().unwrap(),
            vec![repo.path().to_owned()]
        );
        let made = env.created.lock().unwrap().clone();
        assert_eq!(
            made,
            vec![(
                "repo".to_owned(),
                "auto-audit-run-1-20261105T1000".to_owned(),
                Some("develop".to_owned())
            )]
        );
        let d = &env.sent()[0];
        assert_eq!(
            (d.worktree.as_str(), d.created, d.setup),
            ("/wt/auto", true, SetupDecision::Run)
        );
        let run = &r.runs(&a.id)[0];
        assert_eq!(
            (run.worktree.as_deref(), run.worktree_name.as_deref()),
            (Some("/wt/auto"), Some("auto"))
        );
    }

    #[test]
    fn a_worktree_that_cannot_be_made_fails_the_run() {
        let r = rig();
        r.ready();
        let mut env = Fake::new(&r.clock);
        env.create = Err(CmdError {
            code: "git",
            detail: Some("no space".into()),
        });
        let a = r
            .service
            .create(AutomationInput {
                workspace_mode: WorkspaceMode::NewPerRun,
                worktree: None,
                ..input()
            })
            .unwrap();
        r.tick_due(&env);
        assert!(env.sent().is_empty());
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::WorktreeCreateFailed));
        assert_eq!(
            run.error.as_deref(),
            Some("Could not create the workspace: no space")
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_failing_precheck_skips_the_run_and_keeps_its_result() {
        let r = rig();
        r.ready();
        let repo = tempfile::tempdir().unwrap();
        let mut env = Fake::new(&r.clock);
        env.repo = Some(repo.path().to_owned());
        let a = r
            .service
            .create(AutomationInput {
                workspace_mode: WorkspaceMode::NewPerRun,
                worktree: None,
                precheck: Some(Precheck {
                    command: "echo nope >&2; exit 3".into(),
                    timeout_seconds: 10,
                }),
                ..input()
            })
            .unwrap();
        r.tick_due(&env);
        assert!(env.sent().is_empty());
        assert!(env.created.lock().unwrap().is_empty());
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::SkippedPrecheck);
        assert_eq!(run.error.as_deref(), Some("Precheck exited with code 3."));
        let result: &PrecheckResult = run.precheck_result.as_ref().unwrap();
        assert_eq!(
            (result.exit_code, result.command.as_str()),
            (Some(3), "echo nope >&2; exit 3")
        );
        assert_eq!(result.stderr.trim(), "nope");
    }

    #[test]
    fn a_disabled_profile_fails_the_run() {
        let r = rig();
        r.ready();
        let mut env = Fake::new(&r.clock);
        env.profile = None;
        let a = r.service.create(input()).unwrap();
        r.tick_due(&env);
        assert!(env.sent().is_empty());
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::AutomationChanged));
    }

    #[test]
    fn extras_the_agent_does_not_take_fail_the_run() {
        let r = rig();
        r.ready();
        let mut env = Fake::new(&r.clock);
        env.profile = Some(None);
        let a = r
            .service
            .create(AutomationInput {
                extra_agent_args: Some("--model x".into()),
                ..input()
            })
            .unwrap();
        r.tick_due(&env);
        assert!(env.sent().is_empty());
        assert_eq!(r.runs(&a.id)[0].status, RunStatus::DispatchFailed);
    }

    #[test]
    fn the_previous_tab_is_offered_only_when_the_session_is_reused() {
        for reuse in [false, true] {
            let r = rig();
            r.ready();
            let env = Fake::new(&r.clock);
            let a = r
                .service
                .create(AutomationInput {
                    reuse_session: reuse,
                    ..input()
                })
                .unwrap();
            r.tick_due(&env);
            let first = env.sent()[0].run_id.clone();
            r.service.dispatch_result(DispatchResult::Dispatched {
                run_id: first.clone(),
                tab_id: "tab-1".into(),
            });
            // The first run ends, so the next one may start.
            r.service.run_finish(RunFinish {
                run_id: first,
                completed: true,
                output: None,
                truncated: false,
            });
            r.at(T0 + 61 * MIN);
            r.service.tick(&env);
            let sent = env.sent();
            assert_eq!(sent.len(), 2, "{reuse}");
            assert_eq!(
                sent[1].reuse_tab.as_deref(),
                reuse.then_some("tab-1"),
                "{reuse}"
            );
            assert_eq!(r.runs(&a.id).len(), 2);
        }
    }

    #[test]
    fn run_now_queues_a_manual_run_even_when_paused() {
        let r = rig();
        r.ready();
        let env = Fake::new(&r.clock);
        let a = r.service.create(input()).unwrap();
        r.service.set_enabled(&a.id, false).unwrap();
        let run = r.service.run_now(&a.id).unwrap();
        assert_eq!(
            (run.status, run.trigger),
            (RunStatus::Pending, RunTrigger::Manual)
        );
        assert_eq!(run.title, "Audit run 1");
        assert_eq!(r.service.run_now("nope").unwrap_err().code, "not_found");
        r.service.tick(&env);
        assert_eq!(env.sent().len(), 1);
        assert_eq!(r.runs(&a.id)[0].status, RunStatus::Dispatching);
    }

    #[test]
    fn a_scheduled_run_waits_for_the_previous_one_to_end() {
        let r = rig();
        r.ready();
        let env = Fake::new(&r.clock);
        let a = r.service.create(input()).unwrap();
        r.tick_due(&env);
        assert_eq!(env.sent().len(), 1);
        r.service.dispatch_result(DispatchResult::Dispatched {
            run_id: env.sent()[0].run_id.clone(),
            tab_id: "tab-1".into(),
        });
        // The 10:00 run is still open at 11:01: the 11:00 run is skipped, not started beside it.
        r.at(T0 + 61 * MIN);
        r.service.tick(&env);
        assert_eq!(env.sent().len(), 1);
        let runs = r.runs(&a.id);
        assert_eq!(runs.len(), 2);
        let skipped = runs
            .iter()
            .find(|x| x.scheduled_for == T0 + 60 * MIN)
            .unwrap();
        assert_eq!(skipped.status, RunStatus::SkippedUnavailable);
        assert_eq!(skipped.error_code, Some(FailureCode::PreviousRunActive));
        assert_eq!(r.service.list().automations[0].next_run_at, T0 + 120 * MIN);
    }

    #[test]
    fn run_now_is_refused_while_a_run_is_open() {
        let r = rig();
        let a = r.service.create(input()).unwrap();
        r.service.run_now(&a.id).unwrap();
        // Still pending: a second manual run would start beside it.
        assert_eq!(r.service.run_now(&a.id).unwrap_err().code, "bad_arg");
        assert_eq!(r.runs(&a.id).len(), 1);
    }

    #[test]
    fn a_queued_run_waits_until_the_ui_is_ready() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let a = r.service.create(input()).unwrap();
        r.service.run_now(&a.id).unwrap();
        r.service.tick(&env);
        assert!(env.sent().is_empty());
        assert_eq!(r.runs(&a.id)[0].status, RunStatus::Pending);
        r.ready();
        r.service.tick(&env);
        assert_eq!(env.sent().len(), 1);
    }

    fn started(r: &Rig, env: &Fake) -> (Automation, String) {
        r.ready();
        let a = r.service.create(input()).unwrap();
        r.service.run_now(&a.id).unwrap();
        r.service.tick(env);
        (a, env.sent()[0].run_id.clone())
    }

    #[test]
    fn the_ui_report_of_a_launch_moves_the_run() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let (a, run_id) = started(&r, &env);
        let id = r.service.dispatch_result(DispatchResult::Dispatched {
            run_id: run_id.clone(),
            tab_id: "t1".into(),
        });
        assert_eq!(id.as_deref(), Some(a.id.as_str()));
        let run = &r.runs(&a.id)[0];
        assert_eq!(
            (run.status, run.tab_id.as_deref()),
            (RunStatus::Dispatched, Some("t1"))
        );
        // A second report of the same run is ignored.
        assert!(
            r.service
                .dispatch_result(DispatchResult::Failed {
                    run_id: run_id.clone(),
                    code: FailureCode::NeedsApproval,
                    detail: None,
                })
                .is_none()
        );
        assert_eq!(r.runs(&a.id)[0].status, RunStatus::Dispatched);
        // But a launched run fails when its agent never started working.
        r.service.dispatch_result(DispatchResult::Failed {
            run_id: run_id.clone(),
            code: FailureCode::AgentNeverStarted,
            detail: None,
        });
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::AgentNeverStarted));
        assert!(run.tab_id.is_some());
        // Once it is final, nothing more is taken.
        assert!(
            r.service
                .dispatch_result(DispatchResult::Failed {
                    run_id,
                    code: FailureCode::AgentNeverStarted,
                    detail: None,
                })
                .is_none()
        );
    }

    #[test]
    fn a_failed_launch_is_a_failed_run_and_an_approval_is_its_own_status() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let (a, run_id) = started(&r, &env);
        r.service.dispatch_result(DispatchResult::Failed {
            run_id,
            code: FailureCode::AgentNeverStarted,
            detail: Some("x".into()),
        });
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::AgentNeverStarted));

        r.service.run_now(&a.id).unwrap();
        r.service.tick(&env);
        let second = env.sent()[1].run_id.clone();
        r.service.dispatch_result(DispatchResult::Failed {
            run_id: second,
            code: FailureCode::NeedsApproval,
            detail: None,
        });
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::SkippedNeedsInteractiveAuth);
        assert_eq!(run.error_code, Some(FailureCode::NeedsApproval));
    }

    #[test]
    fn a_finished_run_keeps_the_last_lines_of_its_output() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let (a, run_id) = started(&r, &env);
        r.service.dispatch_result(DispatchResult::Dispatched {
            run_id: run_id.clone(),
            tab_id: "t".into(),
        });
        let output = (0..2500)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        r.service.run_finish(RunFinish {
            run_id: run_id.clone(),
            completed: true,
            output: Some(output),
            truncated: false,
        });
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::Completed);
        let snap = run.output_snapshot.as_ref().unwrap();
        assert!(snap.truncated);
        assert_eq!(snap.content.lines().count(), SNAPSHOT_MAX_LINES);
        assert!(snap.content.ends_with("line 2499"));
        // Once final, a late report changes nothing.
        assert!(
            r.service
                .run_finish(RunFinish {
                    run_id,
                    completed: false,
                    output: None,
                    truncated: false,
                })
                .is_none()
        );
    }

    #[test]
    fn a_tab_that_ended_early_is_no_completion() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let (a, run_id) = started(&r, &env);
        r.service.dispatch_result(DispatchResult::Dispatched {
            run_id: run_id.clone(),
            tab_id: "t".into(),
        });
        r.service.run_finish(RunFinish {
            run_id,
            completed: false,
            output: Some("partial".into()),
            truncated: false,
        });
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::AgentNoCompletion));
        assert_eq!(run.output_snapshot.as_ref().unwrap().content, "partial");
    }

    #[test]
    fn a_quit_in_the_middle_of_a_run_ends_it_as_interrupted() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let (a, _) = started(&r, &env);
        assert_eq!(r.runs(&a.id)[0].status, RunStatus::Dispatching);
        r.service.reconcile_startup();
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::AgentInterrupted));
    }

    #[test]
    fn the_watchdog_gives_up_on_a_launch_nobody_answered() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let (a, _) = started(&r, &env);
        r.at(T0 - 30 * MIN + 3 * MIN);
        r.service.tick(&env);
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::DispatchFailed);
        assert_eq!(run.error_code, Some(FailureCode::AgentNeverStarted));
    }

    #[test]
    fn without_a_window_the_refusals_fold_into_one_run() {
        let r = rig();
        let env = Fake::new(&r.clock);
        let a = r.service.create(input()).unwrap();
        r.tick_due(&env);
        r.at(T0 + 61 * MIN);
        r.service.tick(&env);
        r.at(T0 + 121 * MIN);
        r.service.tick(&env);
        let runs = r.runs(&a.id);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::SkippedUnavailable);
        assert_eq!(runs[0].error_code, Some(FailureCode::NoDispatchHost));
        assert_eq!(runs[0].occurrence_count, 3);
        assert_eq!(runs[0].last_occurrence_at, Some(T0 + 120 * MIN));
        assert!(env.sent().is_empty());
    }

    #[test]
    fn a_run_past_its_grace_is_recorded_as_missed() {
        let r = rig();
        r.ready();
        let env = Fake::new(&r.clock);
        let a = r
            .service
            .create(AutomationInput {
                missed_run_grace_minutes: 0,
                ..input()
            })
            .unwrap();
        r.at(T0 + 30 * MIN);
        r.service.tick(&env);
        let run = &r.runs(&a.id)[0];
        assert_eq!(run.status, RunStatus::SkippedMissed);
        assert_eq!(run.error_code, Some(FailureCode::MissedGraceWindow));
        assert!(env.sent().is_empty());
        assert_eq!(r.service.list().automations[0].next_run_at, T0 + 60 * MIN);
    }

    #[test]
    fn a_malformed_stored_schedule_is_one_skip_and_does_not_block_the_others() {
        let r = rig();
        r.ready();
        let env = Fake::new(&r.clock);
        let good = r.service.create(input()).unwrap();
        let bad = r.service.create(input()).unwrap();
        // The file is the only way a rule goes bad after saving; write one in.
        let file = r._dir.path().join("automations.json");
        let mut v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        for item in v["automations"].as_array_mut().unwrap() {
            if item["id"] == bad.id.as_str() {
                item["rrule"] = "FREQ=MONTHLY".into();
                item["nextRunAt"] = T0.into();
            }
        }
        std::fs::write(&file, serde_json::to_string(&v).unwrap()).unwrap();
        let reopened = AutomationService::new(Store::open(r._dir.path()).unwrap(), {
            let c = r.clock.clone();
            move || c.load(Ordering::SeqCst)
        });
        reopened.set_ready(true);
        r.at(T0 + MIN);
        reopened.tick(&env);
        let bad_runs = reopened.get_runs(&bad.id);
        assert_eq!(bad_runs.len(), 1);
        assert_eq!(
            bad_runs[0].error_code,
            Some(FailureCode::UnevaluableSchedule)
        );
        assert_eq!(
            reopened.get_runs(&good.id)[0].status,
            RunStatus::Dispatching
        );
    }

    #[test]
    fn a_tick_that_is_already_running_makes_the_next_one_return_at_once() {
        use std::sync::mpsc;
        struct Slow {
            entered: mpsc::Sender<()>,
            go: Mutex<mpsc::Receiver<()>>,
        }
        impl DispatchEnv for Slow {
            fn now(&self) -> i64 {
                self.entered.send(()).unwrap();
                let _ = self
                    .go
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10));
                T0
            }
            fn precheck_line(&self, _: &Path, _: &str) -> Result<ShellLine, CmdError> {
                unreachable!()
            }
            fn repo_path(&self, _: &str) -> Option<PathBuf> {
                None
            }
            fn worktree_exists(&self, _: &str) -> bool {
                false
            }
            fn create_worktree(
                &self,
                _: &str,
                _: &str,
                _: Option<&str>,
            ) -> Result<(String, String), CmdError> {
                unreachable!()
            }
            fn profile_cli(&self, _: &str) -> Option<Option<Cli>> {
                None
            }
            fn emit_dispatch(&self, _: &AutomationDispatch) {}
            fn emit_changed(&self, _: &AutomationsChanged) {}
        }
        let r = rig();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel();
        let slow = Slow {
            entered: entered_tx,
            go: Mutex::new(go_rx),
        };
        let quick = Fake::new(&r.clock);
        std::thread::scope(|s| {
            s.spawn(|| r.service.tick(&slow));
            entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let before = std::time::Instant::now();
            r.service.tick(&quick);
            assert!(before.elapsed() < Duration::from_secs(2));
            assert!(quick.changed.lock().unwrap().is_empty());
            go_tx.send(()).unwrap();
        });
        // The first tick is over, so a later one runs again.
        let a = r.service.create(input()).unwrap();
        r.service.run_now(&a.id).unwrap();
        r.ready();
        r.service.tick(&quick);
        assert_eq!(quick.sent().len(), 1);
    }

    #[test]
    fn a_schedule_is_checked_with_the_editors_copy_keys() {
        assert_eq!(schedule_error_key("0 9 * * 1-5", "UTC", T0), None);
        assert_eq!(schedule_error_key("FREQ=DAILY;BYHOUR=9", "UTC", T0), None);
        assert_eq!(schedule_error_key("0 9 * *", "UTC", T0), Some("invalid"));
        assert_eq!(schedule_error_key("*/61 * * * *", "UTC", T0), Some("step"));
        assert_eq!(schedule_error_key("0 0 31 2 *", "UTC", T0), Some("noDate"));
        assert_eq!(
            schedule_error_key(&format!("0 9 * * {}", "1,".repeat(1100)), "UTC", T0),
            Some("tooLong")
        );
    }

    #[test]
    fn the_list_carries_the_newest_run_of_each_automation() {
        let r = rig();
        let a = r.service.create(input()).unwrap();
        let b = r.service.create(input()).unwrap();
        let first = r.service.run_now(&a.id).unwrap();
        r.service.dispatch_result(DispatchResult::Failed {
            run_id: first.id,
            code: FailureCode::AgentNeverStarted,
            detail: None,
        });
        let second = r.service.run_now(&a.id).unwrap();
        let view = r.service.list();
        assert_eq!(view.automations.len(), 2);
        assert_eq!(view.last_runs.len(), 1);
        assert_eq!(view.last_runs[0].id, second.id);
        r.service.delete(&b.id).unwrap();
        assert_eq!(r.service.delete(&b.id).unwrap_err().code, "not_found");
        assert_eq!(
            r.service.update("nope", input()).unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            r.service
                .create(AutomationInput {
                    rrule: "nonsense".into(),
                    ..input()
                })
                .unwrap_err()
                .code,
            "invalid_schedule"
        );
    }
}
