//! Orchestration in the app: the shared hub (store, pending UI answers,
//! mail waiters), the events and commands the UI uses, and the endpoint
//! verbs `orchestration.*`. The logic itself lives in `xdev-orch`.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, State};
use xdev_orch::{FailedStage, OrchError, SkillStatus, Store};

use crate::accounts::data_dir;
use crate::cli_verbs::Ctx;
use crate::commands::{AppState, CmdError};
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
    /// Mailboxes a `check --wait` is sleeping on, with how many.
    waiters: Mutex<HashMap<String, u32>>,
    /// What the wake pump remembers.
    pub pump: Arc<crate::orch_pump::Pump>,
    /// Set when the pump should look again; see [`OrchHub::kick_pump`].
    kick: Mutex<bool>,
    kicked: Condvar,
}

/// How long `check --wait` sleeps when the CLI sends no timeout.
pub const WAIT_DEFAULT_MS: u64 = 120_000;
/// How long a coordinator's `ask --wait` sleeps when the CLI sends no timeout.
pub const ASK_WAIT_DEFAULT_MS: u64 = 600_000;
/// The longest a wait may be asked to last.
pub const WAIT_MAX_MS: u64 = 1_800_000;

fn wait_param(req: &Request) -> Duration {
    let ms = req
        .params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(WAIT_DEFAULT_MS)
        .min(WAIT_MAX_MS);
    Duration::from_millis(ms)
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

    /// Sleeps until mail is announced, `timeout` passes or `gone` says the
    /// caller hung up. `ready` is asked after the generation is read, so mail
    /// written in between is never slept through. While it sleeps, `address`
    /// is a waiter: the pump leaves that mailbox alone.
    pub fn wait_mail(
        &self,
        address: &str,
        timeout: Duration,
        gone: &dyn Fn() -> bool,
        mut ready: impl FnMut() -> Result<bool, OrchError>,
    ) -> Result<bool, OrchError> {
        let deadline = std::time::Instant::now() + timeout;
        *self
            .waiters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(address.to_owned())
            .or_insert(0) += 1;
        let out = (|| loop {
            let seen = *self.mail_gen.lock().unwrap_or_else(PoisonError::into_inner);
            if ready()? {
                return Ok(true);
            }
            let now = std::time::Instant::now();
            if now >= deadline || gone() {
                return Ok(false);
            }
            let slice = (deadline - now).min(Duration::from_millis(200));
            let guard = self.mail_gen.lock().unwrap_or_else(PoisonError::into_inner);
            if *guard == seen {
                let _ = self.mail.wait_timeout(guard, slice);
            }
        })();
        let mut waiters = self.waiters.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(n) = waiters.get_mut(address) {
            *n -= 1;
            if *n == 0 {
                waiters.remove(address);
            }
        }
        out
    }

    /// Whether a `check --wait` is sleeping on `address`.
    pub fn has_waiter(&self, address: &str) -> bool {
        self.waiters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(address)
    }

    /// Wakes every `check --wait` and the pump: new mail was written.
    pub fn notify_mail(&self) {
        *self.mail_gen.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        self.mail.notify_all();
        self.kick_pump();
    }

    /// Asks the pump to look again now: the tabs changed or mail came in.
    pub fn kick_pump(&self) {
        *self.kick.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.kicked.notify_all();
    }

    /// Sleeps until [`OrchHub::kick_pump`] or `limit`; true when kicked.
    pub fn wait_kick(&self, limit: Duration) -> bool {
        let guard = self.kick.lock().unwrap_or_else(PoisonError::into_inner);
        let (mut guard, _) = self
            .kicked
            .wait_timeout_while(guard, limit, |k| !*k)
            .unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut *guard)
    }

    pub fn next_read(&self) -> u64 {
        self.next_read.fetch_add(1, Ordering::Relaxed) + 1
    }
}

/// Starts the pump thread: after every tab report and every new message, and
/// at least every two seconds, it points idle tabs at their mail.
pub fn start_pump(app: AppHandle) {
    use tauri::Manager;
    std::thread::spawn(move || {
        let hub = app.state::<OrchHub>();
        loop {
            hub.wait_kick(Duration::from_millis(
                crate::orch_pump::POINTER_GAP_MS as u64,
            ));
            pump_once(&app);
        }
    });
}

fn pump_once(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let Ok(data) = data_dir(&state) else { return };
    // Nothing to do before the first orchestration call made a store.
    if !data.join("orchestration.db").is_file() {
        return;
    }
    let hub = app.state::<OrchHub>();
    let board = app.state::<crate::cli_verbs::CliHub>();
    let Ok(wakes) = hub.with_store(data, |s| s.wake_targets()) else {
        return;
    };
    let (tabs, _) = board.board.tabs();
    let now = crate::workspace::clock().0;
    if let Ok(ready) = hub.with_store(data, |s| s.ready_workers()) {
        let edges = hub.pump.stops(&ready, &tabs);
        let read = |tab: &str| {
            let request = hub.next_read();
            let ask = ReadTab {
                request,
                tab: tab.to_owned(),
                max_chars: 2000,
            };
            hub.reads
                .ask(
                    request,
                    || {
                        if let Ok(p) = to_value(&ask) {
                            let _ = tauri::Emitter::emit(app, "orchestration://read-tab", p);
                        }
                    },
                    Duration::from_secs(2),
                )
                .unwrap_or_default()
        };
        crate::orch_pump::escalate(&hub, data, &edges, &read, now);
    }
    let plans = hub.pump.plan(&wakes, &tabs, &|a| hub.has_waiter(a), now);
    let handle = app.clone();
    let write: crate::orch_pump::Writer = Arc::new(move |tab, bytes| {
        let ptys = handle.state::<crate::pty::Ptys>();
        ptys.with(tab, |s| s.write(bytes.to_vec())).is_ok()
    });
    let probe = app.clone();
    let idle: crate::orch_pump::Probe = Arc::new(move |tab| {
        let (tabs, _) = probe.state::<crate::cli_verbs::CliHub>().board.tabs();
        tabs.iter()
            .any(|t| t.id == tab && t.agent && crate::orch_pump::is_idle(t))
    });
    hub.pump.deliver(
        plans,
        Duration::from_millis(crate::orch_pump::WRITE_DELAY_MS),
        idle,
        write,
    );
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

/// What the skill card shows.
#[tauri::command(async)]
pub fn orchestration_skill_status(app: AppHandle) -> Result<SkillStatus, CmdError> {
    crate::orch_skill::status(&app)
}

/// Installs the skill; `force` replaces edited copies after a backup.
#[tauri::command(async)]
pub fn orchestration_skill_install(app: AppHandle, force: bool) -> Result<SkillStatus, CmdError> {
    crate::orch_skill::install(&app, force)
}

/// The strip's data for the worker in `tab`; none when the tab is no worker's.
#[tauri::command(async)]
pub fn orchestration_worker_lifetime(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    tab: String,
) -> Option<WorkerLifetime> {
    let data = data_dir(&state).ok()?;
    hub.with_store(data, |s| {
        Ok(s.worker_of_tab(&tab)?.map(|w| lifetime_of(&w)))
    })
    .ok()
    .flatten()
}

/// Keeps a worker's tab open (`keep`) or lets it close again.
#[tauri::command(async)]
pub fn orchestration_worker_keep_open(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    tab: String,
    keep: bool,
) -> Result<WorkerLifetime, CmdError> {
    use tauri::Emitter;
    let data = data_dir(&state)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let w = hub
        .with_store(data, |s| {
            let w = s
                .worker_of_tab(&tab)?
                .ok_or_else(|| OrchError::new("not_found", format!("{tab} is no worker's tab")))?;
            s.worker_set_kept(&w.dispatch_id, keep, now)
        })
        .map_err(|e| CmdError {
            code: "orchestration",
            detail: Some(format!("{}: {}", e.code, e.message)),
        })?;
    let _ = app.emit("orchestration://worker-changed", WorkerChanged { tab });
    Ok(lifetime_of(&w))
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

/// Verbs that change nothing; a retry id is not kept for them.
const READ_ONLY: &[&str] = &[
    "run-current",
    "run-list",
    "run-show",
    "task-show",
    "task-list",
    "worker-show",
    "worker-list",
    "gate-list",
    "read",
    "request-show",
];

/// `orchestration.<verb>`; a verb that is not built answers `unsupported`.
/// A request carrying `retryRequest` is answered once: a repeat returns the
/// stored answer and does nothing again.
pub fn handle(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let verb = req
        .method
        .strip_prefix("orchestration.")
        .unwrap_or_default();
    let Some(id) = text_param(req, "retryRequest").filter(|_| !READ_ONLY.contains(&verb)) else {
        return handle_verb(ctx, req, caller, gone);
    };
    if let Some(r) = ctx.orch.with_store(ctx.data, |s| s.receipt_get(&id))? {
        return serde_json::from_str(&r.answer).map_err(|e| AppError::new("store", e.to_string()));
    }
    let answer = handle_verb(ctx, req, caller, gone)?;
    let text = answer.to_string();
    ctx.orch.with_store(ctx.data, |s| {
        s.receipt_put(&id, &req.method, &text, ctx.now_ms)
    })?;
    Ok(answer)
}

fn handle_verb(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
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
        "reset" => {
            let scope = if flag(req, "all") {
                xdev_orch::ResetScope::All
            } else if flag(req, "tasks") {
                xdev_orch::ResetScope::Tasks
            } else if flag(req, "messages") {
                xdev_orch::ResetScope::Messages
            } else {
                return Err(AppError::new(
                    "bad_request",
                    "reset needs --all, --tasks or --messages",
                ));
            };
            let counts = ctx.orch.with_store(ctx.data, |s| {
                let run = match scope {
                    xdev_orch::ResetScope::All => None,
                    _ => Some(
                        s.run_resolve(acting.run.as_deref(), acting.tab.as_deref())?
                            .id,
                    ),
                };
                s.reset(scope, run.as_deref())
            })?;
            to_value(&counts)
        }
        "request-show" => {
            let id = text_param(req, "id")
                .ok_or_else(|| AppError::new("bad_request", "request-show needs a request id"))?;
            let r = ctx
                .orch
                .with_store(ctx.data, |s| s.receipt_get(&id))?
                .ok_or_else(|| AppError::new("not_found", format!("no request {id}")))?;
            let answer: Value = serde_json::from_str(&r.answer).unwrap_or(Value::Null);
            Ok(
                json!({"id": r.request_id, "method": r.method, "answer": answer, "createdMs": r.created_ms}),
            )
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
        "send" => {
            let to = text_param(req, "to")
                .ok_or_else(|| AppError::new("bad_request", "send needs --to"))?;
            let kind = enum_param(req, "type")?.unwrap_or(xdev_orch::MessageType::Status);
            let priority = enum_param(req, "priority")?.unwrap_or(xdev_orch::Priority::Normal);
            let mut payload = match text_param(req, "payload") {
                Some(p) => Some(serde_json::from_str::<Value>(&p).map_err(|e| {
                    AppError::new("bad_request", format!("--payload is not JSON: {e}"))
                })?),
                None => req
                    .params
                    .get("payload")
                    .filter(|v| !v.is_string())
                    .cloned(),
            };
            if let Some(outcome) = text_param(req, "outcome") {
                let mut obj = match payload.take() {
                    Some(Value::Object(o)) => o,
                    _ => serde_json::Map::new(),
                };
                obj.insert("outcome".to_owned(), Value::String(outcome));
                payload = Some(Value::Object(obj));
            }
            let msg = xdev_orch::NewMessage {
                to,
                kind,
                subject: text_param(req, "subject").unwrap_or_default(),
                body: text_param(req, "body").unwrap_or_default(),
                priority,
                payload,
                thread: text_param(req, "thread"),
            };
            let (tabs, _) = ctx.board.tabs();
            let idle = |tab: &str| {
                tabs.iter()
                    .any(|t| t.id == tab && !t.exited && (t.status == "idle" || t.status == "done"))
            };
            let auto_close = ctx.orch_settings.worker_auto_close;
            let (receipt, settled) = ctx.orch.with_store(ctx.data, |s| {
                let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                // A worker's `worker_done` also settles it: say how first.
                let done = match (&me.dispatch, msg.kind) {
                    (Some(d), xdev_orch::MessageType::WorkerDone) => {
                        let outcome = msg
                            .payload
                            .as_ref()
                            .and_then(|p| p["outcome"].as_str())
                            .and_then(|o| match o {
                                "succeeded" => Some(xdev_orch::WorkerState::Succeeded),
                                "failed" => Some(xdev_orch::WorkerState::Failed),
                                _ => None,
                            })
                            .ok_or_else(|| {
                                OrchError::bad_request(
                                    "worker_done needs --outcome succeeded or failed",
                                )
                            })?;
                        Some((d.clone(), outcome))
                    }
                    _ => None,
                };
                let receipt = s.send(&me, &msg, ctx.now_ms, &idle)?;
                let mut tab = None;
                if let Some((d, outcome)) = done
                    && receipt.count > 0
                {
                    let body = (!msg.body.is_empty()).then_some(msg.body.as_str());
                    tab = s
                        .worker_settle(&d, outcome, body, auto_close, ctx.now_ms)?
                        .tab;
                }
                Ok((receipt, tab))
            })?;
            if let Some(tab) = settled {
                changed(ctx, tab)?;
            }
            if receipt.count > 0 {
                ctx.orch.notify_mail();
            }
            to_value(&receipt)
        }
        "check" => {
            let types: Vec<xdev_orch::MessageType> = strings_param(req, "types")
                .iter()
                .map(|t| {
                    xdev_orch::store::enum_from(t)
                        .map_err(|_| AppError::new("bad_request", format!("unknown type {t}")))
                })
                .collect::<Result<_, _>>()?;
            let opts = xdev_orch::CheckOpts {
                peek: flag(req, "peek"),
                all: flag(req, "all"),
                types,
            };
            let me = ctx.orch.with_store(ctx.data, |s| {
                s.identity(acting.tab.as_deref(), acting.run.as_deref())
            })?;
            if flag(req, "wait") {
                let peek_all = xdev_orch::CheckOpts {
                    peek: true,
                    ..opts.clone()
                };
                ctx.orch.wait_mail(&me.address, wait_param(req), gone, || {
                    ctx.orch.with_store(ctx.data, |s| {
                        Ok(!s
                            .check(&me.address, &peek_all, ctx.now_ms)?
                            .messages
                            .is_empty())
                    })
                })?;
            }
            let got = ctx
                .orch
                .with_store(ctx.data, |s| s.check(&me.address, &opts, ctx.now_ms))?;
            to_value(&got)
        }
        "inbox" => {
            let limit = req
                .params
                .get("limit")
                .and_then(Value::as_u64)
                .map_or(20, |n| n.clamp(1, 200) as usize);
            let full = flag(req, "full");
            let rows = ctx.orch.with_store(ctx.data, |s| {
                let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                s.inbox(&me.address, limit, full)
            })?;
            to_value(&rows)
        }
        "reply" => {
            let id = text_param(req, "id")
                .ok_or_else(|| AppError::new("bad_request", "reply needs a message id"))?;
            let body = text_param(req, "body").unwrap_or_default();
            let receipt = ctx.orch.with_store(ctx.data, |s| {
                let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                s.reply(&me, &id, &body, ctx.now_ms)
            })?;
            ctx.orch.notify_mail();
            to_value(&receipt)
        }
        "gate-create" => {
            let question = text_param(req, "question").unwrap_or_default();
            let options = strings_param(req, "options");
            let task = text_param(req, "task").unwrap_or_default();
            let gate = ctx.orch.with_store(ctx.data, |s| {
                let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                s.gate_create(
                    &me.run_id,
                    &task,
                    &question,
                    &options,
                    &me.address,
                    ctx.now_ms,
                )
            })?;
            to_value(&gate)
        }
        "gate-resolve" => {
            let id = text_param(req, "id")
                .ok_or_else(|| AppError::new("bad_request", "gate-resolve needs a gate id"))?;
            let resolution = text_param(req, "resolution")
                .ok_or_else(|| AppError::new("bad_request", "gate-resolve needs --resolution"))?;
            let gate = ctx
                .orch
                .with_store(ctx.data, |s| s.gate_resolve(&id, &resolution, ctx.now_ms))?;
            ctx.orch.notify_mail();
            to_value(&gate)
        }
        "gate-list" => {
            let pending = flag(req, "pending");
            let gates = ctx.orch.with_store(ctx.data, |s| {
                let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                s.gate_list(&me.run_id, pending)
            })?;
            to_value(&gates)
        }
        "ask" => {
            let answer = match text_param(req, "resume") {
                Some(gate) => ctx.orch.with_store(ctx.data, |s| s.ask_resume(&gate))?,
                None => {
                    let question = text_param(req, "question").unwrap_or_default();
                    let options = strings_param(req, "options");
                    let (me, answer) = ctx.orch.with_store(ctx.data, |s| {
                        let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                        let a = s.ask(&me, &question, &options, ctx.now_ms)?;
                        Ok((me, a))
                    })?;
                    if me.dispatch.is_some() {
                        ctx.orch.notify_mail();
                        return to_value(&answer);
                    }
                    answer
                }
            };
            if !answer.pending || !flag(req, "wait") {
                return to_value(&answer);
            }
            let gate = answer.gate_id.clone();
            let mut limit = wait_param(req);
            if req.params.get("timeoutMs").is_none() {
                limit = Duration::from_millis(ASK_WAIT_DEFAULT_MS);
            }
            ctx.orch
                .wait_mail(&format!("gate:{gate}"), limit, gone, || {
                    let a = ctx.orch.with_store(ctx.data, |s| s.ask_resume(&gate))?;
                    Ok(!a.pending)
                })?;
            to_value(&ctx.orch.with_store(ctx.data, |s| s.ask_resume(&gate))?)
        }
        "worker-start" => worker_start(ctx, req, caller, &acting),
        "worker-show" => {
            let id = handle_param(req)?;
            to_value(&ctx.orch.with_store(ctx.data, |s| s.worker_view(&id))?)
        }
        "worker-list" => {
            let state = enum_param(req, "state")?;
            let list = ctx.orch.with_store(ctx.data, |s| {
                let me = s.identity(acting.tab.as_deref(), acting.run.as_deref())?;
                s.worker_list(&me.run_id, state)
            })?;
            to_value(&list)
        }
        "worker-stop" => {
            let id = handle_param(req)?;
            let w = ctx
                .orch
                .with_store(ctx.data, |s| s.worker_stop_begin(&id, ctx.now_ms))?;
            let Some(tab) = w.tab.clone() else {
                let w = ctx
                    .orch
                    .with_store(ctx.data, |s| s.worker_stop_end(&id, true, ctx.now_ms))?;
                return to_value(&w);
            };
            changed(ctx, tab.clone())?;
            (ctx.emit)(
                "orchestration://close-worker",
                to_value(&WorkerClose {
                    dispatch: id.clone(),
                    tab: tab.clone(),
                })?,
            );
            let went = wait_tab_gone(ctx, &tab, Duration::from_millis(STOP_WAIT_MS), gone);
            let w = ctx
                .orch
                .with_store(ctx.data, |s| s.worker_stop_end(&id, went, ctx.now_ms))?;
            changed(ctx, tab)?;
            if !went {
                return Err(AppError::new(
                    "stop_unknown",
                    format!(
                        "the tab of {id} did not close in time; run worker-stop again or look at it"
                    ),
                ));
            }
            to_value(&w)
        }
        "worker-abandon" => {
            let id = handle_param(req)?;
            let w = ctx
                .orch
                .with_store(ctx.data, |s| s.worker_abandon(&id, ctx.now_ms))?;
            if let Some(tab) = w.tab.clone() {
                changed(ctx, tab)?;
            }
            to_value(&w)
        }
        "worker-release" => {
            let id = handle_param(req)?;
            let outcome = match text_param(req, "outcome").as_deref() {
                Some("succeeded") => xdev_orch::WorkerState::Succeeded,
                Some("failed") => xdev_orch::WorkerState::Failed,
                _ => {
                    return Err(AppError::new(
                        "bad_request",
                        "worker-release needs --outcome succeeded or failed",
                    ));
                }
            };
            let result = text_param(req, "result");
            let auto_close = ctx.orch_settings.worker_auto_close;
            let w = ctx.orch.with_store(ctx.data, |s| {
                let now = s.worker_get(&id)?;
                if matches!(
                    now.state,
                    xdev_orch::WorkerState::Succeeded | xdev_orch::WorkerState::Failed
                ) {
                    return Err(OrchError::new(
                        "already_released",
                        format!("{id} is already {:?}", now.state),
                    ));
                }
                s.worker_settle(&id, outcome, result.as_deref(), auto_close, ctx.now_ms)
            })?;
            if let Some(tab) = w.tab.clone() {
                changed(ctx, tab)?;
            }
            to_value(&w)
        }
        "worker-keep-open" => {
            let id = handle_param(req)?;
            let keep = !flag(req, "off");
            let w = ctx
                .orch
                .with_store(ctx.data, |s| s.worker_set_kept(&id, keep, ctx.now_ms))?;
            if let Some(tab) = w.tab.clone() {
                changed(ctx, tab)?;
            }
            to_value(&lifetime_of(&w))
        }
        "worker-read" => {
            let id = handle_param(req)?;
            let max_chars = req
                .params
                .get("maxChars")
                .and_then(Value::as_u64)
                .map_or(8000, |n| n.clamp(1, 200_000) as u32);
            let w = ctx.orch.with_store(ctx.data, |s| s.worker_get(&id))?;
            let tab = w
                .tab
                .ok_or_else(|| AppError::new("not_found", format!("{id} has no tab")))?;
            let request = ctx.orch.next_read();
            let text = ctx
                .orch
                .reads
                .ask(
                    request,
                    || {
                        let payload = to_value(&ReadTab {
                            request,
                            tab,
                            max_chars,
                        });
                        if let Ok(p) = payload {
                            (ctx.emit)("orchestration://read-tab", p);
                        }
                    },
                    Duration::from_millis(READ_WAIT_MS),
                )
                .ok_or_else(|| {
                    AppError::new("read_unavailable", "the terminal did not answer in time")
                })?;
            Ok(serde_json::json!({ "text": text }))
        }
        other => Err(AppError::new(
            "unsupported",
            format!("orchestration {other} is not built yet"),
        )),
    }
}

/// How long `worker-stop` waits for the tab to leave the board.
const STOP_WAIT_MS: u64 = if cfg!(test) { 150 } else { 10_000 };
/// How long `worker-read` waits for the terminal's text.
const READ_WAIT_MS: u64 = if cfg!(test) { 100 } else { 5_000 };

fn handle_param(req: &Request) -> Result<String, AppError> {
    text_param(req, "handle")
        .ok_or_else(|| AppError::new("bad_request", "this verb needs --handle <dispatch id>"))
}

/// Tells the UI the strip over `tab` changed.
fn changed(ctx: &Ctx<'_>, tab: String) -> Result<(), AppError> {
    (ctx.emit)(
        "orchestration://worker-changed",
        to_value(&WorkerChanged { tab })?,
    );
    Ok(())
}

fn lifetime_of(w: &xdev_orch::Worker) -> WorkerLifetime {
    WorkerLifetime {
        kept: w.kept,
        closes_at_ms: w.closes_at_ms,
        finished: matches!(
            w.state,
            xdev_orch::WorkerState::Succeeded | xdev_orch::WorkerState::Failed
        ),
    }
}

/// Whether `tab` is off the board before `limit` ends (or the caller leaves).
fn wait_tab_gone(ctx: &Ctx<'_>, tab: &str, limit: Duration, gone: &dyn Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + limit;
    loop {
        if !ctx.board.tabs().0.iter().any(|t| t.id == tab) {
            return true;
        }
        if std::time::Instant::now() >= deadline || gone() {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// The tab `--terminal` names, when it may become a worker: an open agent
/// tab that sits idle, so the preamble is typed into an agent's prompt and
/// never into a shell or over a turn in progress.
fn terminal_target(ctx: &Ctx<'_>, t: &str) -> Result<crate::cli_verbs::TabReport, AppError> {
    let (tabs, _) = ctx.board.tabs();
    let found = tabs
        .into_iter()
        .find(|x| x.id == t && !x.exited)
        .ok_or_else(|| AppError::new("not_found", format!("no open terminal {t}")))?;
    if !found.agent {
        return Err(AppError::new(
            "terminal_not_agent",
            format!("terminal {t} runs no agent; start one in it first"),
        ));
    }
    if found.status != "idle" && found.status != "done" {
        return Err(AppError::new(
            "terminal_busy",
            format!("terminal {t} is {}; wait until it is idle", found.status),
        ));
    }
    Ok(found)
}

/// How long the UI gets, on top of the readiness wait, to answer `open-worker`.
const OPEN_SLACK_MS: u64 = if cfg!(test) { 50 } else { 10_000 };
/// How long a worker's tab gets to show its agent when the CLI sends no timeout.
const READY_DEFAULT_MS: u64 = 60_000;

/// `worker-start`: records a dispatch, opens (or reuses) a tab, hands it the
/// preamble and answers with a receipt. The store is never held while the UI
/// is asked.
fn worker_start(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    acting: &Acting,
) -> Result<Value, AppError> {
    for key in ["model", "effort"] {
        if req.params.get(key).is_some_and(|v| !v.is_null()) {
            return Err(AppError::new(
                "unsupported",
                format!("--{key} is not supported yet; the agent profile decides it"),
            ));
        }
    }
    let task_param = text_param(req, "task");
    let spec_param = text_param(req, "spec");
    let retry_param = text_param(req, "retryOf");
    if task_param.is_none() && spec_param.is_none() {
        return Err(AppError::new(
            "bad_request",
            "worker-start needs --task <id> or --spec <text>",
        ));
    }
    let pick: xdev_orch::WorktreePick = match req.params.get("worktree").filter(|v| !v.is_null()) {
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| AppError::new("bad_request", format!("bad --worktree: {e}")))?,
        None => xdev_orch::WorktreePick::Current,
    };
    let setup = text_param(req, "setup").unwrap_or_else(|| "inherit".to_owned());
    if !["inherit", "skip", "run"].contains(&setup.as_str()) {
        return Err(AppError::new(
            "bad_request",
            format!("--setup is inherit, skip or run, not {setup}"),
        ));
    }
    let ready_ms = req
        .params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(READY_DEFAULT_MS);
    let max_depth = ctx.orch_settings.nested_worker_max_depth;
    let terminal = text_param(req, "terminal");
    if let Some(t) = &terminal {
        terminal_target(ctx, t)?;
    }

    // 1. Who starts what: the run, the depth, the task.
    let (me, depth, task) = ctx.orch.with_store(ctx.data, |s| {
        let me = match s.identity(acting.tab.as_deref(), acting.run.as_deref()) {
            Ok(me) => me,
            Err(e) if e.code == "no_run" && spec_param.is_some() => {
                let run = s.run_create("", acting.tab.as_deref(), ctx.now_ms)?;
                xdev_orch::Identity {
                    address: format!("run:{}", run.id),
                    run_id: run.id,
                    dispatch: None,
                }
            }
            Err(e) => return Err(e),
        };
        let depth = s.depth_for_child(me.dispatch.as_deref())?;
        if depth > max_depth {
            return Err(OrchError::new(
                "nested_worker_depth_exceeded",
                format!("workers may nest {max_depth} deep; this one would be at {depth}"),
            ));
        }
        let task = match (&task_param, &spec_param) {
            (Some(id), _) => s.task_get(id)?,
            (None, Some(spec)) => {
                let parent = match &me.dispatch {
                    Some(d) => Some(s.dispatch_get(d)?.task_id),
                    None => None,
                };
                s.task_create(
                    &me.run_id,
                    xdev_orch::NewTask {
                        title: None,
                        spec: spec.clone(),
                        deps: Vec::new(),
                        parent,
                    },
                    ctx.now_ms,
                )?
            }
            (None, None) => unreachable!("checked above"),
        };
        if task.run_id != me.run_id {
            return Err(OrchError::bad_request(format!(
                "task {} is not in run {}",
                task.id, me.run_id
            )));
        }
        // A broken chain says so before the task's own state does.
        if let Some(prev) = &retry_param {
            s.retry_failures(prev, &me.run_id)?;
        }
        if task.status != xdev_orch::TaskStatus::Ready {
            return Err(OrchError::new(
                "invalid_transition",
                format!(
                    "task {} is not ready, so no worker can start on it",
                    task.id
                ),
            ));
        }
        // Too big a spec fails here, before a tab or worktree is made.
        xdev_orch::build_preamble(&xdev_orch::PreambleInput {
            run: &me.run_id,
            task: &task.id,
            dispatch: "disp_check",
            spec: &task.spec,
            depth,
            max_depth,
            cli: "xdev",
        })?;
        Ok((me, depth, task))
    })?;

    // 2. Where: an existing tab, or a worktree and a new tab.
    let (tabs, _) = ctx.board.tabs();
    let default_agent = acting
        .tab
        .as_deref()
        .and_then(|t| tabs.iter().find(|x| x.id == t))
        .map(|t| t.profile.clone())
        .unwrap_or_default();
    let agent = text_param(req, "agent").unwrap_or(default_agent);
    let (tab, worktree, mut kept) = match &terminal {
        Some(t) => {
            let found = terminal_target(ctx, t)?;
            // The person's tab: never closed behind them.
            (t.clone(), found.worktree, true)
        }
        None => {
            let (path, made) = crate::cli_verbs::pick_worktree(
                ctx,
                caller,
                &pick,
                text_param(req, "name").as_deref(),
            )?;
            (
                ctx.orch.with_store(ctx.data, |s| Ok(s.next_id("tab")))?,
                path,
                made,
            )
        }
    };
    kept |= flag(req, "keepOpen");

    // 3. Record it, then build what the worker starts with.
    let plan = xdev_orch::StartPlan {
        run_id: me.run_id.clone(),
        task_id: task.id.clone(),
        parent_dispatch: me.dispatch.clone(),
        depth,
        retry_of: retry_param,
        tab: tab.clone(),
        worktree: worktree.clone(),
        agent: agent.clone(),
        kept,
    };
    let dispatch = ctx
        .orch
        .with_store(ctx.data, |s| s.worker_begin(&plan, ctx.now_ms))?;
    let prompt = xdev_orch::build_preamble(&xdev_orch::PreambleInput {
        run: &me.run_id,
        task: &task.id,
        dispatch: &dispatch.id,
        spec: &task.spec,
        depth,
        max_depth,
        cli: "xdev",
    })?;

    // 4. Open the tab (or type into the given one) and wait for the UI.
    let result = match terminal {
        Some(_) => {
            let paste = format!("\x1b[200~{prompt}\x1b[201~\r");
            if (ctx.write_pty)(&tab, paste.as_bytes()) {
                xdev_orch::StartResult::Ready
            } else {
                xdev_orch::StartResult::Failed {
                    stage: FailedStage::DispatchInput,
                    error: format!("terminal {tab} did not take the text"),
                }
            }
        }
        None => {
            let open = WorkerOpen {
                dispatch: dispatch.id.clone(),
                tab: tab.clone(),
                title: format!("worker-{}", task.id),
                worktree: worktree.clone(),
                profile: agent,
                prompt,
                setup,
                ready_timeout_ms: ready_ms,
            };
            let payload = to_value(&open)?;
            let wait = Duration::from_millis(ready_ms + OPEN_SLACK_MS);
            let answer = ctx.orch.opens.ask(
                dispatch.id.clone(),
                || (ctx.emit)("orchestration://open-worker", payload),
                wait,
            );
            match answer {
                Some(WorkerOpenOutcome::Ok) => xdev_orch::StartResult::Ready,
                Some(WorkerOpenOutcome::Failed { stage, error }) => {
                    xdev_orch::StartResult::Failed { stage, error }
                }
                None => xdev_orch::StartResult::Unknown,
            }
        }
    };
    let receipt = ctx.orch.with_store(ctx.data, |s| {
        s.worker_started(&dispatch.id, result, ctx.now_ms)
    })?;
    (ctx.emit)(
        "orchestration://worker-changed",
        to_value(&WorkerChanged { tab })?,
    );
    to_value(&receipt)
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
    fn mail_verbs_send_check_inbox_and_reply_between_two_runs_tabs() {
        let f = crate::cli_verbs::tests::fixture();
        let call =
            |tab: &str, m: &str, p: Value| f.call(Some(tab), &format!("orchestration.{m}"), p);
        let run = call("p-lead", "run-create", json!({"objective": "o"})).unwrap();
        let to = format!("run:{}", run["id"].as_str().unwrap());

        // A second tab joins the run and mails the coordinator.
        call("p-child", "run-use", json!({"id": run["id"]})).unwrap();
        let sent = call(
            "p-child",
            "send",
            json!({"to": to, "type": "question", "subject": "q", "body": "which?", "payload": "{\"a\":1}"}),
        )
        .unwrap();
        assert_eq!(sent["count"], 1);
        let bad = call("p-child", "send", json!({"to": to, "payload": "{nope"}));
        assert_eq!(bad.unwrap_err().code, "bad_request");
        let group = call(
            "p-child",
            "send",
            json!({"to": "@all", "type": "heartbeat"}),
        );
        assert_eq!(group.unwrap_err().code, "bad_request");

        let inbox = call("p-lead", "inbox", json!({})).unwrap();
        assert_eq!(inbox.as_array().unwrap().len(), 1);
        assert_eq!(inbox[0]["read"], false);
        let peek = call("p-lead", "check", json!({"peek": true})).unwrap();
        assert_eq!(peek["messages"].as_array().unwrap().len(), 1);
        let got = call("p-lead", "check", json!({})).unwrap();
        let msg = &got["messages"][0];
        assert_eq!(msg["body"], "which?");
        assert_eq!(msg["payload"]["a"], 1);
        assert_eq!(got["rendered"].as_array().unwrap().len(), 1);
        assert_eq!(got["remaining"], 0);
        let none = call("p-lead", "check", json!({})).unwrap();
        assert!(none["messages"].as_array().unwrap().is_empty());

        // Only the addressee answers; the answer is mail for the asker.
        // Both tabs are coordinators of one run and share its mailbox, so the
        // answer to a message sent by the run lands in the run's mailbox.
        let missing = call("p-lead", "reply", json!({"id": "msg_nope", "body": "x"}));
        assert_eq!(missing.unwrap_err().code, "not_found");
        call("p-lead", "reply", json!({"id": msg["id"], "body": "this"})).unwrap();
        let back = call("p-lead", "check", json!({"types": ["status"]})).unwrap();
        assert_eq!(back["messages"][0]["subject"], "Re: q");
        assert_eq!(back["messages"][0]["threadId"], msg["id"]);
    }

    #[test]
    fn check_wait_sleeps_until_mail_arrives_or_the_timeout_passes() {
        let f = crate::cli_verbs::tests::fixture();
        let call =
            |tab: &str, m: &str, p: Value| f.call(Some(tab), &format!("orchestration.{m}"), p);
        let run = call("p-lead", "run-create", json!({"objective": "o"})).unwrap();
        let to = format!("run:{}", run["id"].as_str().unwrap());

        let t0 = std::time::Instant::now();
        let none = call("p-lead", "check", json!({"wait": true, "timeoutMs": 300})).unwrap();
        assert!(none["messages"].as_array().unwrap().is_empty());
        assert!(t0.elapsed() >= Duration::from_millis(250));

        call("p-child", "run-use", json!({"id": run["id"]})).unwrap();
        std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                call("p-child", "send", json!({"to": to, "body": "late"})).unwrap();
            });
            let t0 = std::time::Instant::now();
            let got = call(
                "p-lead",
                "check",
                json!({"wait": true, "timeoutMs": 10_000}),
            )
            .unwrap();
            assert_eq!(got["messages"][0]["body"], "late");
            assert!(t0.elapsed() < Duration::from_secs(5));
        });
        // Mail already there: no sleep at all.
        call("p-child", "send", json!({"to": to, "body": "now"})).unwrap();
        let t0 = std::time::Instant::now();
        let got = call(
            "p-lead",
            "check",
            json!({"wait": true, "timeoutMs": 10_000}),
        )
        .unwrap();
        assert_eq!(got["messages"][0]["body"], "now");
        assert!(t0.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_waiter_is_registered_while_it_sleeps_and_a_hangup_ends_the_wait() {
        let hub = OrchHub::default();
        let hung_up = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|sc| {
            let waiting = sc.spawn(|| {
                hub.wait_mail(
                    "run:r",
                    Duration::from_secs(30),
                    &|| hung_up.load(Ordering::Relaxed),
                    || Ok(false),
                )
            });
            let t0 = std::time::Instant::now();
            while !hub.has_waiter("run:r") {
                assert!(t0.elapsed() < Duration::from_secs(5), "never registered");
                std::thread::sleep(Duration::from_millis(10));
            }
            hung_up.store(true, Ordering::Relaxed);
            assert!(!waiting.join().unwrap().unwrap());
        });
        assert!(!hub.has_waiter("run:r"));
    }

    #[test]
    fn gates_ask_and_resolve_across_a_waiting_coordinator() {
        let f = crate::cli_verbs::tests::fixture();
        let call =
            |tab: &str, m: &str, p: Value| f.call(Some(tab), &format!("orchestration.{m}"), p);
        call("p-lead", "run-create", json!({"objective": "o"})).unwrap();

        let g = call(
            "p-lead",
            "gate-create",
            json!({"question": "ship?", "options": ["yes", "no"]}),
        )
        .unwrap();
        assert_eq!(g["status"], "pending");
        assert_eq!(g["options"], json!(["yes", "no"]));
        let bad = call("p-lead", "gate-create", json!({"question": ""}));
        assert_eq!(bad.unwrap_err().code, "bad_request");
        let list = call("p-lead", "gate-list", json!({"pending": true})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);

        // Not waiting: pending at once, then resumable.
        let a = call("p-lead", "ask", json!({"question": "go?"})).unwrap();
        assert_eq!(a["pending"], true);
        let timed = call(
            "p-lead",
            "ask",
            json!({"resume": a["gateId"], "wait": true, "timeoutMs": 200}),
        )
        .unwrap();
        assert_eq!(timed["pending"], true);

        // Waiting: resolved from another thread while the ask sleeps.
        std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                call(
                    "p-child",
                    "gate-resolve",
                    json!({"id": a["gateId"], "resolution": "go"}),
                )
                .unwrap();
            });
            let got = call(
                "p-lead",
                "ask",
                json!({"resume": a["gateId"], "wait": true, "timeoutMs": 10_000}),
            )
            .unwrap();
            assert_eq!(got["pending"], false);
            assert_eq!(got["resolution"], "go");
        });
        let again = call(
            "p-lead",
            "gate-resolve",
            json!({"id": a["gateId"], "resolution": "x"}),
        );
        assert_eq!(again.unwrap_err().code, "invalid_transition");
        let missing = call("p-lead", "ask", json!({"resume": "gate_nope"}));
        assert_eq!(missing.unwrap_err().code, "not_found");
        let list = call("p-lead", "gate-list", json!({"pending": true})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
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

    fn opened(f: &crate::cli_verbs::tests::Fixture) -> Vec<Value> {
        f.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "orchestration://open-worker")
            .map(|(_, p)| p.clone())
            .collect()
    }

    #[test]
    fn worker_start_opens_a_tab_with_the_preamble_and_answers_with_a_receipt() {
        let mut f = crate::cli_verbs::tests::fixture();
        f.open_answer = Some(WorkerOpenOutcome::Ok);
        let call = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        // With no run yet, a spec makes one.
        let r = call("worker-start", json!({"spec": "do x"})).unwrap();
        assert_eq!(r["state"], "ready");
        assert_eq!(r["next"], xdev_orch::render::NEXT_STARTED);
        let open = &opened(&f)[0];
        assert_eq!(open["dispatch"], r["dispatchId"]);
        assert_eq!(
            open["title"],
            format!("worker-{}", r["taskId"].as_str().unwrap())
        );
        assert_eq!(open["setup"], "inherit");
        // With no --timeout the agent gets a minute to show itself.
        assert_eq!(open["readyTimeoutMs"], 60_000);
        assert!(open["worktree"].as_str().unwrap().ends_with("lead"));
        assert!(
            open["prompt"]
                .as_str()
                .unwrap()
                .ends_with("=== TASK ===\ndo x\n")
        );
        // The task is taken, so it cannot be started again.
        let again = call("worker-start", json!({"task": r["taskId"]}));
        assert_eq!(again.unwrap_err().code, "invalid_transition");
        // Neither a task nor a spec, nor a flag that is not built.
        assert_eq!(
            call("worker-start", json!({})).unwrap_err().code,
            "bad_request"
        );
        let model = call("worker-start", json!({"spec": "y", "model": "m"}));
        assert_eq!(model.unwrap_err().code, "unsupported");
    }

    #[test]
    fn a_failed_open_names_the_stage_and_an_unanswered_one_is_unknown() {
        let mut f = crate::cli_verbs::tests::fixture();
        f.open_answer = Some(WorkerOpenOutcome::Failed {
            stage: FailedStage::AgentReadiness,
            error: "no prompt".to_owned(),
        });
        let call = |f: &crate::cli_verbs::tests::Fixture, m: &str, p: Value| {
            f.call(Some("p-lead"), &format!("orchestration.{m}"), p)
        };
        call(&f, "run-create", json!({})).unwrap();
        let r = call(&f, "worker-start", json!({"spec": "a"})).unwrap();
        assert_eq!(r["state"], "failed");
        assert_eq!(r["failedStage"], "agent_readiness");
        assert_eq!(r["lastError"], "no prompt");
        // The task went back to ready.
        let ready = call(&f, "task-list", json!({"ready": true})).unwrap();
        assert_eq!(ready[0]["id"], r["taskId"]);

        f.open_answer = None;
        let u = call(
            &f,
            "worker-start",
            json!({"task": r["taskId"], "timeoutMs": 0}),
        )
        .unwrap();
        assert_eq!(u["state"], "start_unknown");
        assert!(u["recovery"].is_string());
    }

    #[test]
    fn the_third_failed_start_of_a_chain_opens_the_breaker() {
        let mut f = crate::cli_verbs::tests::fixture();
        f.open_answer = Some(WorkerOpenOutcome::Failed {
            stage: FailedStage::TerminalCreate,
            error: "x".to_owned(),
        });
        let call = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        let mut r = call("worker-start", json!({"spec": "a"})).unwrap();
        let task = r["taskId"].clone();
        for _ in 0..2 {
            r = call(
                "worker-start",
                json!({"task": task, "retryOf": r["dispatchId"]}),
            )
            .unwrap();
        }
        assert_eq!(r["next"], xdev_orch::render::NEXT_BREAKER);
        let more = call(
            "worker-start",
            json!({"task": task, "retryOf": r["dispatchId"]}),
        );
        assert_eq!(more.unwrap_err().code, "circuit_broken");
    }

    #[test]
    fn a_worker_may_start_workers_only_within_the_depth_limit() {
        let mut f = crate::cli_verbs::tests::fixture();
        f.open_answer = Some(WorkerOpenOutcome::Ok);
        let lead = |f: &crate::cli_verbs::tests::Fixture, p: Value| {
            f.call(Some("p-lead"), "orchestration.worker-start", p)
        };
        lead(&f, json!({"spec": "top"})).unwrap();
        let worker_tab = opened(&f)[0]["tab"].as_str().unwrap().to_owned();
        let sub = json!({"spec": "sub", "worktree": {"selector": "other"}});
        // The default allows one level: the worker may not start another.
        let e = f.call(Some(&worker_tab), "orchestration.worker-start", sub.clone());
        assert_eq!(e.unwrap_err().code, "nested_worker_depth_exceeded");
        // Raised to 2 it may, at depth 2, and its task hangs under its own.
        f.max_depth = 2;
        let ok = f
            .call(Some(&worker_tab), "orchestration.worker-start", sub)
            .unwrap();
        assert_eq!(ok["state"], "ready");
        let prompt = opened(&f)[1]["prompt"].as_str().unwrap().to_owned();
        assert!(prompt.contains("Depth: 2 of 2"));
        assert!(!prompt.contains("SUB-DISPATCH"));
        assert!(
            opened(&f)[1]["worktree"]
                .as_str()
                .unwrap()
                .ends_with("other")
        );
    }

    #[test]
    fn terminal_mode_types_into_the_given_tab_and_fails_when_it_cannot() {
        let mut f = crate::cli_verbs::tests::fixture();
        f.board.replace(
            vec![crate::cli_verbs::tests::tab("t9", &f.other, true, "idle")],
            None,
        );
        let call = |f: &crate::cli_verbs::tests::Fixture, p: Value| {
            f.call(Some("p-lead"), "orchestration.worker-start", p)
        };
        let r = call(&f, json!({"spec": "go", "terminal": "t9"})).unwrap();
        assert_eq!(r["state"], "ready");
        assert!(opened(&f).is_empty());
        let writes = f.pty_writes.lock().unwrap().clone();
        assert_eq!(writes[0].0, "t9");
        let text = String::from_utf8(writes[0].1.clone()).unwrap();
        assert!(text.starts_with("\u{1b}[200~") && text.ends_with("\u{1b}[201~\r"));
        assert!(text.contains("=== TASK ===\ngo"));

        let none = call(&f, json!({"spec": "go", "terminal": "nope"}));
        assert_eq!(none.unwrap_err().code, "not_found");
        f.pty_alive = false;
        let dead = call(&f, json!({"spec": "go", "terminal": "t9"})).unwrap();
        assert_eq!(dead["state"], "failed");
        assert_eq!(dead["failedStage"], "dispatch_input");
    }

    #[test]
    fn terminal_mode_refuses_a_shell_or_a_busy_agent_and_writes_nothing() {
        let f = crate::cli_verbs::tests::fixture();
        f.board.replace(
            vec![
                crate::cli_verbs::tests::tab("sh", &f.other, false, "idle"),
                crate::cli_verbs::tests::tab("busy", &f.other, true, "working"),
                crate::cli_verbs::tests::tab("asks", &f.other, true, "needs-you"),
            ],
            None,
        );
        for (t, code) in [
            ("sh", "terminal_not_agent"),
            ("busy", "terminal_busy"),
            ("asks", "terminal_busy"),
        ] {
            let e = f
                .call(
                    Some("p-lead"),
                    "orchestration.worker-start",
                    json!({"spec": "go", "terminal": t}),
                )
                .unwrap_err();
            assert_eq!(e.code, code, "{t}");
        }
        assert!(f.pty_writes.lock().unwrap().is_empty());
        // Refused before anything was recorded: no run, task or worker.
        let runs = f
            .call(Some("p-lead"), "orchestration.run-list", json!({}))
            .unwrap();
        assert_eq!(runs.as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_tab_whose_terminal_worker_finished_can_start_workers_again() {
        let mut f = crate::cli_verbs::tests::fixture();
        f.open_answer = Some(WorkerOpenOutcome::Ok);
        f.board.replace(
            vec![crate::cli_verbs::tests::tab(
                "p-lead", &f.lead, true, "idle",
            )],
            None,
        );
        let r = f
            .call(
                Some("p-lead"),
                "orchestration.worker-start",
                json!({"spec": "mine", "terminal": "p-lead"}),
            )
            .unwrap();
        let run = r["runId"].as_str().unwrap();
        f.call(
            Some("p-lead"),
            "orchestration.send",
            json!({"to": format!("run:{run}"), "type": "worker_done", "outcome": "succeeded"}),
        )
        .unwrap();
        let next = f
            .call(
                Some("p-lead"),
                "orchestration.worker-start",
                json!({"spec": "theirs"}),
            )
            .unwrap();
        assert_eq!(next["state"], "ready");
        assert_eq!(next["runId"], run);
    }

    #[test]
    fn terminal_mode_pastes_a_spec_without_its_control_characters() {
        let f = crate::cli_verbs::tests::fixture();
        f.board.replace(
            vec![crate::cli_verbs::tests::tab("t9", &f.other, true, "idle")],
            None,
        );
        f.call(
            Some("p-lead"),
            "orchestration.worker-start",
            json!({"spec": "go\u{1b}[201~whoami\r", "terminal": "t9"}),
        )
        .unwrap();
        let writes = f.pty_writes.lock().unwrap().clone();
        let text = String::from_utf8(writes[0].1.clone()).unwrap();
        let inner = text
            .strip_prefix("\u{1b}[200~")
            .and_then(|t| t.strip_suffix("\u{1b}[201~\r"))
            .unwrap();
        assert!(
            !inner.contains('\u{1b}') && !inner.contains('\r'),
            "{inner:?}"
        );
        assert!(inner.ends_with("go[201~whoami\n"), "{inner:?}");
    }

    fn events_named(f: &crate::cli_verbs::tests::Fixture, name: &str) -> Vec<Value> {
        f.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == name)
            .map(|(_, p)| p.clone())
            .collect()
    }

    /// A fixture with one ready worker; returns it, the receipt and its tab.
    fn with_worker() -> (crate::cli_verbs::tests::Fixture, Value, String) {
        let mut f = crate::cli_verbs::tests::fixture();
        f.open_answer = Some(WorkerOpenOutcome::Ok);
        let r = f
            .call(
                Some("p-lead"),
                "orchestration.worker-start",
                json!({"spec": "do x"}),
            )
            .unwrap();
        let tab = opened(&f)[0]["tab"].as_str().unwrap().to_owned();
        (f, r, tab)
    }

    #[test]
    fn worker_done_from_the_worker_settles_it_and_the_task() {
        let (f, r, tab) = with_worker();
        let run = r["runId"].as_str().unwrap();
        let handle = r["dispatchId"].clone();
        // A done without a valid outcome is refused and changes nothing.
        let bad = f.call(
            Some(&tab),
            "orchestration.send",
            json!({"to": format!("run:{run}"), "type": "worker_done", "outcome": "maybe"}),
        );
        assert_eq!(bad.unwrap_err().code, "bad_request");
        let show = |f: &crate::cli_verbs::tests::Fixture| {
            f.call(
                Some("p-lead"),
                "orchestration.worker-show",
                json!({"handle": handle}),
            )
            .unwrap()
        };
        assert_eq!(show(&f)["worker"]["state"], "ready");

        f.call(
            Some(&tab),
            "orchestration.send",
            json!({"to": format!("run:{run}"), "type": "worker_done", "outcome": "succeeded", "body": "all good"}),
        )
        .unwrap();
        let v = show(&f);
        assert_eq!(v["worker"]["state"], "succeeded");
        assert_eq!(v["taskStatus"], "completed");
        assert!(v["worker"]["closesAtMs"].is_i64());
        assert!(
            !events_named(&f, "orchestration://worker-changed").is_empty(),
            "the strip is told"
        );
        let list = f
            .call(
                Some("p-lead"),
                "orchestration.worker-list",
                json!({"state": "succeeded"}),
            )
            .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    #[test]
    fn keep_open_stops_the_countdown_and_stop_refuses_a_kept_worker() {
        let (f, r, tab) = with_worker();
        let handle = r["dispatchId"].clone();
        let call = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        let k = call("worker-keep-open", json!({"handle": handle})).unwrap();
        assert_eq!(k["kept"], true);
        let e = call("worker-stop", json!({"handle": handle}));
        assert_eq!(e.unwrap_err().code, "worker_kept");
        let off = call("worker-keep-open", json!({"handle": handle, "off": true})).unwrap();
        assert_eq!(off["kept"], false);
        assert!(
            events_named(&f, "orchestration://worker-changed")
                .iter()
                .any(|e| e["tab"] == tab)
        );
    }

    #[test]
    fn stop_closes_the_tab_when_it_leaves_the_board_and_says_unknown_when_it_does_not() {
        let (f, r, tab) = with_worker();
        let handle = r["dispatchId"].clone();
        // The tab stays on the board: the stop cannot be confirmed.
        f.board.replace(
            vec![crate::cli_verbs::tests::tab(&tab, &f.other, true, "idle")],
            None,
        );
        let e = f.call(
            Some("p-lead"),
            "orchestration.worker-stop",
            json!({"handle": handle}),
        );
        assert_eq!(e.unwrap_err().code, "stop_unknown");
        assert_eq!(events_named(&f, "orchestration://close-worker").len(), 1);
        // Once it has gone, asking again ends in stopped.
        f.board.replace(vec![], None);
        let w = f
            .call(
                Some("p-lead"),
                "orchestration.worker-stop",
                json!({"handle": handle}),
            )
            .unwrap();
        assert_eq!(w["state"], "stopped");
    }

    #[test]
    fn abandon_and_release_move_a_worker_out_of_ready() {
        let (f, r, _tab) = with_worker();
        let handle = r["dispatchId"].clone();
        let call = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        let none = call("worker-release", json!({"handle": handle}));
        assert_eq!(none.unwrap_err().code, "bad_request");
        let rel = call(
            "worker-release",
            json!({"handle": handle, "outcome": "failed", "result": "gave up"}),
        )
        .unwrap();
        assert_eq!(rel["state"], "failed");
        let again = call(
            "worker-release",
            json!({"handle": handle, "outcome": "succeeded"}),
        );
        assert_eq!(again.unwrap_err().code, "already_released");

        let r2 = call("worker-start", json!({"spec": "two"})).unwrap();
        let ab = call("worker-abandon", json!({"handle": r2["dispatchId"]})).unwrap();
        assert_eq!(ab["state"], "abandoned");
    }

    #[test]
    fn worker_read_asks_the_terminal_and_times_out_when_nobody_answers() {
        let (f, r, tab) = with_worker();
        let e = f.call(
            Some("p-lead"),
            "orchestration.worker-read",
            json!({"handle": r["dispatchId"], "maxChars": 50}),
        );
        assert_eq!(e.unwrap_err().code, "read_unavailable");
        let asked = events_named(&f, "orchestration://read-tab");
        assert_eq!(asked[0]["tab"], tab);
        assert_eq!(asked[0]["maxChars"], 50);
    }

    #[test]
    fn a_retried_request_answers_once_and_request_show_remembers_it() {
        let f = crate::cli_verbs::tests::fixture();
        let call = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        let first = call(
            "run-create",
            json!({"objective": "o", "retryRequest": "req-1"}),
        )
        .unwrap();
        let again = call(
            "run-create",
            json!({"objective": "o", "retryRequest": "req-1"}),
        )
        .unwrap();
        assert_eq!(first, again);
        assert_eq!(
            call("run-list", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let shown = call("request-show", json!({"id": "req-1"})).unwrap();
        assert_eq!(shown["method"], "orchestration.run-create");
        assert_eq!(shown["answer"], first);
        assert_eq!(
            call("request-show", json!({"id": "nope"}))
                .unwrap_err()
                .code,
            "not_found"
        );
    }

    #[test]
    fn reset_forgets_by_scope() {
        let f = crate::cli_verbs::tests::fixture();
        let call = |m: &str, p: Value| f.call(Some("p-lead"), &format!("orchestration.{m}"), p);
        call("run-create", json!({"objective": "o"})).unwrap();
        assert_eq!(call("reset", json!({})).unwrap_err().code, "bad_request");
        let n = call("reset", json!({"all": true})).unwrap();
        assert_eq!(n["runs"], 1);
        assert!(
            call("run-list", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
