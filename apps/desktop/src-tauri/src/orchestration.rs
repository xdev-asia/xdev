//! Orchestration in the app: the shared hub (store, pending UI answers,
//! mail waiters), the events and commands the UI uses, and the endpoint
//! verbs `orchestration.*`. The logic itself lives in `xdev-orch`.

// The verbs that use these land task by task; the allow goes once they all have.
#![allow(dead_code)]
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use xdev_orch::{FailedStage, OrchError, SkillStatus, Store};

use crate::cli_verbs::Ctx;
use crate::commands::CmdError;
use crate::endpoint::{AppError, Caller, Request};
use crate::settings::{OrchestrationSettings, SettingsSection};
use crate::settings_store;

/// Payload of `orchestration://open-worker`: open a tab with this id and
/// title in the background, wait for setup and the agent, paste `prompt`,
/// then answer with `orchestration_worker_opened`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkerOpen {
    pub dispatch: String,
    pub tab: String,
    pub title: String,
    pub worktree: String,
    pub profile: String,
    pub prompt: String,
    /// `inherit` runs the repo's setup first; `skip` does not.
    pub setup: String,
    pub ready_timeout_ms: u64,
}

/// The UI's answer to `open-worker`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkerOpenOutcome {
    Ok,
    Failed { stage: FailedStage, error: String },
}

/// Payload of `orchestration://close-worker`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkerClose {
    pub dispatch: String,
    pub tab: String,
}

/// Payload of `orchestration://read-tab`; answered by `orchestration_read_answer`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReadTab {
    pub request: u64,
    pub tab: String,
    pub max_chars: u32,
}

/// Payload of `orchestration://worker-changed`: re-read the strip of `tab`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkerChanged {
    pub tab: String,
}

/// What the strip over a worker's terminal needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkerLifetime {
    pub kept: bool,
    pub closes_at_ms: Option<i64>,
    pub finished: bool,
}

/// Answers the UI owes, keyed by what was asked: a sender is parked before
/// the event goes out, so a fast answer is never lost.
pub struct Pending<K, T> {
    map: Mutex<HashMap<K, mpsc::Sender<T>>>,
}

impl<K, T> Default for Pending<K, T> {
    fn default() -> Self {
        Pending {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Hash + Eq + Clone, T> Pending<K, T> {
    fn lock(&self) -> MutexGuard<'_, HashMap<K, mpsc::Sender<T>>> {
        self.map.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Parks `key`, runs `send` (the emit), and waits up to `wait` for the answer.
    pub fn ask(&self, key: K, send: impl FnOnce(), wait: Duration) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        self.lock().insert(key.clone(), tx);
        send();
        let answer = rx.recv_timeout(wait).ok();
        self.lock().remove(&key);
        answer
    }

    /// An unknown or late key is ignored.
    pub fn answer(&self, key: &K, value: T) {
        if let Some(tx) = self.lock().remove(key) {
            let _ = tx.send(value);
        }
    }
}

/// What the endpoint, the pump and the UI's commands share.
#[derive(Default)]
pub struct OrchHub {
    store: Mutex<Option<Store>>,
    pub opens: Pending<String, WorkerOpenOutcome>,
    pub reads: Pending<u64, String>,
    next_read: AtomicU64,
    /// Bumped on every new message; `check --wait` sleeps on it.
    pub mail: Condvar,
    pub mail_gen: Mutex<u64>,
}

impl OrchHub {
    /// Runs `f` on the store, opening `<data>/orchestration.db` first when
    /// it is not open yet. The lock is held for `f` only: never across a
    /// wait on the UI.
    pub fn with_store<R>(
        &self,
        data: &std::path::Path,
        f: impl FnOnce(&Store) -> Result<R, OrchError>,
    ) -> Result<R, OrchError> {
        let mut guard = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(Store::open(&data.join("orchestration.db"))?);
        }
        match guard.as_ref() {
            Some(store) => f(store),
            None => Err(OrchError::new("store", "the store is not open")),
        }
    }

    pub fn next_read(&self) -> u64 {
        self.next_read.fetch_add(1, Ordering::Relaxed) + 1
    }
}

impl From<OrchError> for AppError {
    fn from(e: OrchError) -> AppError {
        AppError::new(e.code, e.message)
    }
}

/// Settings → Orchestration as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn orchestration_settings_get(app: AppHandle) -> OrchestrationSettings {
    settings_store::read(&app).orchestration
}

/// Stores Settings → Orchestration (the depth clamped to 1..=9) and returns it.
#[tauri::command(async)]
pub fn orchestration_settings_put(
    app: AppHandle,
    settings: OrchestrationSettings,
) -> Result<OrchestrationSettings, CmdError> {
    let settings = settings.normalized();
    settings_store::write(&app, &[SettingsSection::Orchestration], |s| {
        s.orchestration = settings;
    })
    .map(|s| s.orchestration)
}

/// What the skill card shows. Filled in with the skill install.
#[tauri::command(async)]
pub fn orchestration_skill_status(_app: AppHandle) -> Result<SkillStatus, CmdError> {
    Ok(SkillStatus {
        install_command: "xdev skills install".to_owned(),
        ..SkillStatus::default()
    })
}

/// Installs the skill. Filled in with the skill install.
#[tauri::command(async)]
pub fn orchestration_skill_install(_app: AppHandle, _force: bool) -> Result<SkillStatus, CmdError> {
    Err(CmdError {
        code: "unsupported",
        detail: Some("the skill install is not built yet".to_owned()),
    })
}

/// The strip's data for the worker in `tab`; none when the tab is no worker's.
#[tauri::command(async)]
pub fn orchestration_worker_lifetime(
    _hub: State<'_, OrchHub>,
    _tab: String,
) -> Option<WorkerLifetime> {
    None
}

/// Keeps a worker's tab open (`keep`) or lets it close again.
#[tauri::command(async)]
pub fn orchestration_worker_keep_open(
    _app: AppHandle,
    _hub: State<'_, OrchHub>,
    _tab: String,
    _keep: bool,
) -> Result<WorkerLifetime, CmdError> {
    Err(CmdError {
        code: "unsupported",
        detail: Some("keep open is not built yet".to_owned()),
    })
}

/// The UI's answer to `orchestration://open-worker`.
#[tauri::command]
pub fn orchestration_worker_opened(
    hub: State<'_, OrchHub>,
    dispatch: String,
    outcome: WorkerOpenOutcome,
) {
    hub.opens.answer(&dispatch, outcome);
}

/// The UI's answer to `orchestration://read-tab`.
#[tauri::command]
pub fn orchestration_read_answer(hub: State<'_, OrchHub>, request: u64, text: String) {
    hub.reads.answer(&request, text);
}

/// The tab and run a verb acts for, from its params and the caller.
struct Acting {
    /// `--as <tab>`, else the terminal the CLI runs in.
    tab: Option<String>,
    run: Option<String>,
}

impl Acting {
    fn of(req: &Request, caller: &Caller) -> Acting {
        let text = |key: &str| {
            req.params
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        Acting {
            tab: text("as").or_else(|| caller.pty.clone()),
            run: text("run"),
        }
    }
}

fn text_param(req: &Request, key: &str) -> Option<String> {
    req.params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn strings_param(req: &Request, key: &str) -> Vec<String> {
    req.params
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn flag(req: &Request, key: &str) -> bool {
    req.params
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A unit enum named in a param (`--status ready`).
fn enum_param<T: serde::de::DeserializeOwned>(
    req: &Request,
    key: &str,
) -> Result<Option<T>, AppError> {
    match text_param(req, key) {
        None => Ok(None),
        Some(name) => xdev_orch::store::enum_from(&name)
            .map(Some)
            .map_err(|_| AppError::new("bad_request", format!("unknown {key} {name}"))),
    }
}

fn to_value<T: Serialize>(v: &T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|e| AppError::new("store", e.to_string()))
}

/// `orchestration.<verb>`; a verb that is not built answers `unsupported`.
pub fn handle(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    _gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let verb = req
        .method
        .strip_prefix("orchestration.")
        .unwrap_or_default();
    let acting = Acting::of(req, caller);
    match verb {
        "run-create" => {
            let objective = text_param(req, "objective").unwrap_or_default();
            let run = ctx.orch.with_store(ctx.data, |s| {
                s.run_create(&objective, acting.tab.as_deref(), ctx.now_ms)
            })?;
            to_value(&run)
        }
        "run-use" => {
            let id = text_param(req, "id")
                .ok_or_else(|| AppError::new("bad_request", "run-use needs a run id"))?;
            let tab = acting.tab.as_deref().ok_or_else(|| {
                AppError::new(
                    "no_run",
                    "not called from an xDev terminal; pass --as <tab>",
                )
            })?;
            let run = ctx.orch.with_store(ctx.data, |s| s.run_use(tab, &id))?;
            to_value(&run)
        }
        "run-current" => {
            let run = ctx.orch.with_store(ctx.data, |s| {
                s.run_resolve(acting.run.as_deref(), acting.tab.as_deref())
            })?;
            to_value(&run)
        }
        "run-list" => to_value(&ctx.orch.with_store(ctx.data, |s| s.run_list())?),
        "run-show" => {
            let detail = ctx.orch.with_store(ctx.data, |s| {
                let id = match text_param(req, "id").or_else(|| acting.run.clone()) {
                    Some(id) => id,
                    None => s.run_current(acting.tab.as_deref())?.id,
                };
                s.run_show(&id)
            })?;
            to_value(&detail)
        }
        "task-create" => {
            let spec = text_param(req, "spec").unwrap_or_default();
            let new = xdev_orch::NewTask {
                title: text_param(req, "title"),
                spec,
                deps: strings_param(req, "deps"),
                parent: text_param(req, "parent"),
            };
            let task = ctx.orch.with_store(ctx.data, |s| {
                let run = s.run_resolve(acting.run.as_deref(), acting.tab.as_deref())?;
                s.task_create(&run.id, new, ctx.now_ms)
            })?;
            to_value(&task)
        }
        "task-list" => {
            let filter = xdev_orch::TaskFilter {
                status: enum_param(req, "status")?,
                ready: flag(req, "ready"),
            };
            let mut tasks = ctx.orch.with_store(ctx.data, |s| {
                let run = s.run_resolve(acting.run.as_deref(), acting.tab.as_deref())?;
                s.task_list(&run.id, &filter)
            })?;
            if flag(req, "brief") {
                for t in &mut tasks {
                    t.spec = xdev_orch::brief(&t.spec);
                }
            }
            to_value(&tasks)
        }
        "task-update" => {
            let id = text_param(req, "id")
                .ok_or_else(|| AppError::new("bad_request", "task-update needs a task id"))?;
            let status = enum_param(req, "status")?;
            let result = text_param(req, "result");
            let task = ctx.orch.with_store(ctx.data, |s| {
                s.task_update(&id, status, result.as_deref(), ctx.now_ms)
            })?;
            to_value(&task)
        }
        other => Err(AppError::new(
            "unsupported",
            format!("orchestration {other} is not built yet"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_answer_reaches_a_waiting_ask_and_a_late_one_is_ignored() {
        let pending: Pending<String, u8> = Pending::default();
        // Answered from inside the emit, as a fast UI would.
        let got = pending.ask(
            "a".to_owned(),
            || pending.answer(&"a".to_owned(), 7),
            Duration::from_secs(2),
        );
        assert_eq!(got, Some(7));
        pending.answer(&"a".to_owned(), 9);
        let none = pending.ask("b".to_owned(), || {}, Duration::from_millis(30));
        assert_eq!(none, None);
    }

    #[test]
    fn the_open_outcome_reads_the_ui_shape() {
        let ok: WorkerOpenOutcome = serde_json::from_str(r#"{"kind":"ok"}"#).unwrap();
        assert_eq!(ok, WorkerOpenOutcome::Ok);
        let failed: WorkerOpenOutcome = serde_json::from_str(
            r#"{"kind":"failed","stage":"agent_readiness","error":"no prompt"}"#,
        )
        .unwrap();
        assert_eq!(
            failed,
            WorkerOpenOutcome::Failed {
                stage: FailedStage::AgentReadiness,
                error: "no prompt".to_owned()
            }
        );
    }

    #[test]
    fn run_verbs_create_use_list_and_show_for_the_calling_tab() {
        let f = crate::cli_verbs::tests::fixture();
        let none = f.call(Some("p-lead"), "orchestration.run-current", json!({}));
        assert_eq!(none.unwrap_err().code, "no_run");

        let a = f
            .call(
                Some("p-lead"),
                "orchestration.run-create",
                json!({"objective": "ship"}),
            )
            .unwrap();
        assert_eq!(a["objective"], "ship");
        assert_eq!(a["coordinatorTab"], "p-lead");
        let cur = f.call(Some("p-lead"), "orchestration.run-current", json!({}));
        assert_eq!(cur.unwrap()["id"], a["id"]);

        let b = f
            .call(Some("p-other"), "orchestration.run-create", json!({}))
            .unwrap();
        // p-child has no run of its own and there are two: it must choose.
        let err = f.call(Some("p-child"), "orchestration.run-current", json!({}));
        assert_eq!(err.unwrap_err().code, "no_run");
        let used = f
            .call(
                Some("p-child"),
                "orchestration.run-use",
                json!({"id": b["id"]}),
            )
            .unwrap();
        assert_eq!(used["id"], b["id"]);
        // `as` acts for another tab, `run` overrides the current run.
        let cur = f.call(None, "orchestration.run-current", json!({"as": "p-lead"}));
        assert_eq!(cur.unwrap()["id"], a["id"]);
        let list = f.call(None, "orchestration.run-list", json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        let show = f
            .call(Some("p-lead"), "orchestration.run-show", json!({}))
            .unwrap();
        assert_eq!(show["run"]["id"], a["id"]);
        assert_eq!(show["openGates"], 0);
        let missing = f.call(None, "orchestration.run-show", json!({"id": "run_x"}));
        assert_eq!(missing.unwrap_err().code, "not_found");
        let outside = f.call(None, "orchestration.run-use", json!({"id": a["id"]}));
        assert_eq!(outside.unwrap_err().code, "no_run");
    }

    #[test]
    fn the_hub_opens_its_store_in_the_data_dir_on_first_use() {
        let dir = tempfile::tempdir().unwrap();
        let hub = OrchHub::default();
        let version = hub.with_store(dir.path(), |s| s.version()).unwrap();
        assert_eq!(version, 1);
        assert!(dir.path().join("orchestration.db").is_file());
    }

    #[test]
    fn task_verbs_build_a_dag_in_the_current_run() {
        let f = crate::cli_verbs::tests::fixture();
        let t = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        assert_eq!(
            t("task-create", json!({"spec": "a"})).unwrap_err().code,
            "no_run"
        );
        t("run-create", json!({"objective": "o"})).unwrap();
        let a = t(
            "task-create",
            json!({"spec": "first
line", "title": "A"}),
        )
        .unwrap();
        assert_eq!(a["status"], "ready");
        let b = t("task-create", json!({"spec": "b", "deps": [a["id"]]})).unwrap();
        assert_eq!(b["status"], "pending");
        let bad = t("task-create", json!({"spec": "c", "deps": ["task_nope"]}));
        assert_eq!(bad.unwrap_err().code, "bad_request");

        let ready = t("task-list", json!({"ready": true, "brief": true})).unwrap();
        assert_eq!(ready.as_array().unwrap().len(), 1);
        assert_eq!(ready[0]["spec"], "first line");
        let badf = t("task-list", json!({"status": "nonsense"}));
        assert_eq!(badf.unwrap_err().code, "bad_request");

        t(
            "task-update",
            json!({"id": a["id"], "status": "completed", "result": "ok"}),
        )
        .unwrap();
        let pending = t("task-list", json!({"status": "ready"})).unwrap();
        assert_eq!(pending[0]["id"], b["id"]);
        let again = t("task-update", json!({"id": a["id"], "status": "failed"}));
        assert_eq!(again.unwrap_err().code, "invalid_transition");
    }
}
