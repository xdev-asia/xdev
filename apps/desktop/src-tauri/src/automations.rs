//! Automations in the app: the managed service the commands (and, later, the CLI endpoint)
//! share, the 60 s tick thread, and the events that ask the UI to open a tab. The UI owns
//! tabs, so a dispatch is an event and the outcome comes back as a command.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use xdev_automations::precheck::ShellLine;
use xdev_automations::{
    Automation, AutomationInput, AutomationRun, Describe, FailureCode, SetupDecision, Store,
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

fn not_ready() -> CmdError {
    CmdError {
        code: "bad_arg",
        detail: Some("not implemented".into()),
    }
}

/// Shared by the commands and, later, the endpoint's `automation.*` arms.
pub struct AutomationService {
    #[allow(dead_code)]
    store: Mutex<Store>,
    #[allow(dead_code)]
    ui_ready: AtomicBool,
    #[allow(dead_code)]
    evaluating: AtomicBool,
}

/// What the tick needs from the app; a fake in tests.
#[allow(dead_code)]
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

#[allow(dead_code, clippy::unused_self)]
impl AutomationService {
    pub fn open(data_dir: &Path) -> AutomationService {
        let store = Store::open(data_dir).expect("an empty store opens");
        AutomationService {
            store: Mutex::new(store),
            ui_ready: AtomicBool::new(false),
            evaluating: AtomicBool::new(false),
        }
    }
    pub fn list(&self) -> AutomationsView {
        AutomationsView {
            automations: Vec::new(),
            last_runs: Vec::new(),
        }
    }
    pub fn get_runs(&self, _automation_id: &str) -> Vec<AutomationRun> {
        Vec::new()
    }
    pub fn create(&self, _input: AutomationInput) -> Result<Automation, CmdError> {
        Err(not_ready())
    }
    pub fn update(&self, _id: &str, _input: AutomationInput) -> Result<Automation, CmdError> {
        Err(not_ready())
    }
    pub fn set_enabled(&self, _id: &str, _on: bool) -> Result<Automation, CmdError> {
        Err(not_ready())
    }
    pub fn delete(&self, _id: &str) -> Result<(), CmdError> {
        Err(not_ready())
    }
    pub fn run_now(&self, _id: &str) -> Result<AutomationRun, CmdError> {
        Err(not_ready())
    }
    /// One evaluation pass.
    pub fn tick(&self, _env: &dyn DispatchEnv) {}
    pub fn ui_ready(&self) {}
    pub fn dispatch_result(&self, _result: DispatchResult) {}
    pub fn run_finish(&self, _finish: RunFinish) {}
}

/// Starts the tick thread.
pub fn start(_app: &AppHandle) {}

fn service(app: &AppHandle) -> Result<tauri::State<'_, AutomationService>, CmdError> {
    use tauri::Manager;
    app.try_state::<AutomationService>().ok_or(CmdError {
        code: "bad_arg",
        detail: Some("no data folder".into()),
    })
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
    service(&app)?.create(input)
}

#[tauri::command(async)]
pub fn automation_update(
    app: AppHandle,
    id: String,
    input: AutomationInput,
) -> Result<Automation, CmdError> {
    service(&app)?.update(&id, input)
}

#[tauri::command(async)]
pub fn automation_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Automation, CmdError> {
    service(&app)?.set_enabled(&id, enabled)
}

#[tauri::command(async)]
pub fn automation_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    service(&app)?.delete(&id)
}

#[tauri::command(async)]
pub fn automation_run_now(app: AppHandle, id: String) -> Result<AutomationRun, CmdError> {
    service(&app)?.run_now(&id)
}

#[tauri::command(async)]
pub fn automation_describe(expr: String, timezone: String) -> Describe {
    xdev_automations::schedule::describe(&expr, &timezone, crate::workspace::clock().0)
}

/// The error copy key of a schedule that cannot be saved, or `None` when it can.
#[tauri::command(async)]
pub fn automation_validate_schedule(expr: String, timezone: String) -> Option<String> {
    let _ = (expr, timezone);
    Some("invalid".into())
}

/// The next `count` (at most 5) occurrences from `dtstart`, for the editor preview.
#[tauri::command(async)]
pub fn automation_next_runs(
    expr: String,
    timezone: String,
    dtstart: i64,
    count: usize,
) -> Vec<i64> {
    let _ = (expr, timezone, dtstart, count);
    Vec::new()
}

#[tauri::command(async)]
pub fn automation_ui_ready(app: AppHandle) -> Result<(), CmdError> {
    service(&app)?.ui_ready();
    Ok(())
}

#[tauri::command(async)]
pub fn automation_dispatch_result(app: AppHandle, result: DispatchResult) -> Result<(), CmdError> {
    service(&app)?.dispatch_result(result);
    Ok(())
}

#[tauri::command(async)]
pub fn automation_run_finish(app: AppHandle, finish: RunFinish) -> Result<(), CmdError> {
    service(&app)?.run_finish(finish);
    Ok(())
}
