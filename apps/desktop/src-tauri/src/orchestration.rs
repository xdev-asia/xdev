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

/// `orchestration.<verb>`: every verb answers `unsupported` until it is built.
pub fn handle(
    _ctx: &Ctx<'_>,
    req: &Request,
    _caller: &Caller,
    _gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let verb = req
        .method
        .strip_prefix("orchestration.")
        .unwrap_or_default();
    Err(AppError::new(
        "unsupported",
        format!("orchestration {verb} is not built yet"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn the_hub_opens_its_store_in_the_data_dir_on_first_use() {
        let dir = tempfile::tempdir().unwrap();
        let hub = OrchHub::default();
        let version = hub.with_store(dir.path(), |s| s.version()).unwrap();
        assert_eq!(version, 1);
        assert!(dir.path().join("orchestration.db").is_file());
    }
}
