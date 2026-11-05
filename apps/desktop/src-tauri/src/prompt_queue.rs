//! The per-tab prompt queue in the app: `prompt-queue.json`, the service the commands share and the
//! pass the automation tick runs. The window owns the tabs and the verified send, so a due item is an
//! event and the outcome comes back as a command. The due-time logic is `xdev_automations::prompt_queue`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use xdev_automations::prompt_queue::{
    Facts, Item, NewItem, Queue, QueueError, SendReport, WhenInput,
};

use crate::atomic::write_atomic;
use crate::commands::CmdError;

pub const DUE_EVENT: &str = "prompt-queue://due";
pub const CHANGED_EVENT: &str = "prompt-queue://changed";

const FILE_NAME: &str = "prompt-queue.json";
const FILE_VERSION: u32 = 1;
/// The window's facts older than this are not trusted (it may be gone): it reports at least this often.
pub const FACTS_TTL_MS: i64 = 120_000;

/// Items the window must send now; they are already marked as being sent.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PromptQueueDue {
    pub items: Vec<Item>,
}

/// The queue changed; read it again.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PromptQueueChanged {}

#[derive(Serialize, Deserialize)]
struct FileData {
    version: u32,
    #[serde(default)]
    items: Vec<Item>,
}

fn err(code: &'static str, detail: Option<&str>) -> CmdError {
    CmdError {
        code,
        detail: detail.map(str::to_owned),
    }
}

fn from_queue(e: QueueError) -> CmdError {
    match e {
        QueueError::NotFound => err("not_found", None),
        QueueError::Empty => err("bad_arg", Some("empty")),
        QueueError::TooLarge => err("too_large", Some("prompt")),
        QueueError::TooMany => err("too_large", Some("items")),
        QueueError::Busy => err("bad_arg", Some("busy")),
    }
}

fn io(e: impl std::fmt::Display) -> CmdError {
    err("io", Some(&e.to_string()))
}

/// The queue and the file it is kept in. `path` is `None` for an in-memory store.
pub struct Store {
    path: Option<PathBuf>,
    queue: Queue,
}

impl Store {
    #[cfg(test)]
    pub fn memory() -> Store {
        Store {
            path: None,
            queue: Queue::default(),
        }
    }

    /// Opens `prompt-queue.json` in `dir`. A file that cannot be read is kept as `.bad` and the queue
    /// starts empty. What was being sent when the app quit pauses its tab.
    pub fn open(dir: &Path) -> Store {
        let path = dir.join(FILE_NAME);
        let mut queue = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<FileData>(&bytes) {
                Ok(data) => Queue { items: data.items },
                Err(e) => {
                    eprintln!("prompt queue: {e}");
                    let _ = fs::rename(&path, path.with_extension("json.bad"));
                    Queue::default()
                }
            },
            Err(_) => Queue::default(),
        };
        let recovered = queue.recover();
        let store = Store {
            path: Some(path),
            queue,
        };
        if recovered {
            let _ = store.save();
        }
        store
    }

    pub fn save(&self) -> Result<(), CmdError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let data = FileData {
            version: FILE_VERSION,
            items: self.queue.items.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&data).map_err(io)?;
        write_atomic(path, &bytes).map_err(io)
    }

    #[cfg(test)]
    pub fn queue(&self) -> &Queue {
        &self.queue
    }
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

/// What the window last said, and when.
#[derive(Default)]
struct Reported {
    facts: Facts,
    at: i64,
}

/// Shared by the commands and the tick. The store is behind one mutex, never held across an event.
pub struct PromptQueueService {
    store: Mutex<Store>,
    reported: Mutex<Reported>,
    clock: Clock,
}

impl PromptQueueService {
    pub fn new(store: Store, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        PromptQueueService {
            store: Mutex::new(store),
            reported: Mutex::new(Reported::default()),
            clock: Box::new(clock),
        }
    }

    pub fn open(data_dir: &Path) -> Self {
        Self::new(Store::open(data_dir), || crate::workspace::clock().0)
    }

    fn store(&self) -> MutexGuard<'_, Store> {
        // Every write is saved whole, so a panic leaves no half-made state to guard.
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    pub fn list(&self) -> Vec<Item> {
        self.store().queue.items.clone()
    }

    /// Runs `edit` on the queue and saves it; a failed `edit` leaves nothing changed.
    fn change<T>(
        &self,
        edit: impl FnOnce(&mut Queue, i64) -> Result<T, QueueError>,
    ) -> Result<T, CmdError> {
        let now = self.now();
        let mut store = self.store();
        let before = store.queue.clone();
        let out = edit(&mut store.queue, now).map_err(from_queue)?;
        if let Err(e) = store.save() {
            store.queue = before;
            return Err(e);
        }
        Ok(out)
    }

    pub fn add(&self, new: NewItem) -> Result<Item, CmdError> {
        self.change(|q, now| q.add(new, now, uuid::Uuid::new_v4().to_string()))
    }

    pub fn update(&self, id: &str, text: String, when: WhenInput) -> Result<Item, CmdError> {
        self.change(|q, now| q.update(id, text, when, now))
    }

    pub fn delete(&self, id: &str) -> Result<(), CmdError> {
        self.change(|q, _| q.delete(id))
    }

    pub fn reorder(&self, id: &str, delta: i32) -> Result<(), CmdError> {
        self.change(|q, _| q.reorder(id, delta))
    }

    pub fn send_now(&self, id: &str) -> Result<Item, CmdError> {
        self.change(|q, _| q.send_now(id))
    }

    pub fn report(&self, id: &str, report: SendReport) -> Result<(), CmdError> {
        self.change(|q, _| q.report(id, report))
    }

    /// Keeps what the window says of its tabs and quotas; true when it differs from before.
    pub fn set_facts(&self, facts: Facts) -> bool {
        let now = self.now();
        let mut reported = self.reported.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = reported.facts != facts;
        reported.facts = facts;
        reported.at = now;
        changed
    }

    /// The window is gone: nothing is due until it reports again.
    pub fn forget_facts(&self) {
        let mut reported = self.reported.lock().unwrap_or_else(PoisonError::into_inner);
        reported.facts.ready = false;
    }

    /// One pass: decides what is due, marks it and returns the items to send; `changed` says whether
    /// the list changed (an item was sent on, closed or looked at again).
    pub fn tick(&self) -> Tick {
        let now = self.now();
        let facts = {
            let reported = self.reported.lock().unwrap_or_else(PoisonError::into_inner);
            let mut facts = reported.facts.clone();
            if now - reported.at > FACTS_TTL_MS {
                facts.ready = false;
            }
            facts
        };
        let mut store = self.store();
        let steps = store.queue.plan(&facts, now);
        if steps.is_empty() {
            return Tick::default();
        }
        let before = store.queue.clone();
        store.queue.apply(&steps);
        if let Err(e) = store.save() {
            // Not saved: nothing was handed out, the next pass decides again.
            eprintln!("prompt queue save: {}", e.code);
            store.queue = before;
            return Tick::default();
        }
        let due = steps
            .iter()
            .filter_map(|s| match s {
                xdev_automations::prompt_queue::Step::Fire { id } => {
                    store.queue.items.iter().find(|i| &i.id == id).cloned()
                }
                _ => None,
            })
            .collect();
        Tick { due, changed: true }
    }
}

#[derive(Debug, Default)]
pub struct Tick {
    pub due: Vec<Item>,
    pub changed: bool,
}

fn service(app: &AppHandle) -> Result<tauri::State<'_, PromptQueueService>, CmdError> {
    use tauri::Manager;
    app.try_state::<PromptQueueService>()
        .ok_or_else(|| err("bad_arg", Some("no data folder")))
}

fn announce(app: &AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(CHANGED_EVENT, PromptQueueChanged {});
}

/// The queue's pass of the automation tick: items that are due go to the window.
pub fn tick(app: &AppHandle) {
    use tauri::{Emitter, Manager};
    let Some(service) = app.try_state::<PromptQueueService>() else {
        return;
    };
    let pass = service.tick();
    if pass.changed {
        announce(app);
    }
    if !pass.due.is_empty() {
        let _ = app.emit(DUE_EVENT, PromptQueueDue { items: pass.due });
    }
}

/// The window is gone: nothing is due until it reports again.
pub fn window_gone(app: &AppHandle) {
    use tauri::Manager;
    if let Some(service) = app.try_state::<PromptQueueService>() {
        service.forget_facts();
    }
}

/// Every queued prompt of every tab, in the order they go.
#[tauri::command(async)]
pub fn prompt_queue_list(app: AppHandle) -> Result<Vec<Item>, CmdError> {
    Ok(service(&app)?.list())
}

/// Queues a prompt at the end of its tab's queue (50 per tab; 16 KB per prompt, `too_large` past them).
#[tauri::command(async)]
pub fn prompt_queue_add(app: AppHandle, item: NewItem) -> Result<Item, CmdError> {
    let made = service(&app)?.add(item)?;
    announce(&app);
    crate::automations::kick(&app);
    Ok(made)
}

#[tauri::command(async)]
pub fn prompt_queue_update(
    app: AppHandle,
    id: String,
    text: String,
    when: WhenInput,
) -> Result<Item, CmdError> {
    let made = service(&app)?.update(&id, text, when)?;
    announce(&app);
    crate::automations::kick(&app);
    Ok(made)
}

/// Removes an item that is not being sent; also "Skip" for one that failed.
#[tauri::command(async)]
pub fn prompt_queue_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    service(&app)?.delete(&id)?;
    announce(&app);
    crate::automations::kick(&app);
    Ok(())
}

/// Moves an item one place up (`delta` below 0) or down in its tab's queue.
#[tauri::command(async)]
pub fn prompt_queue_reorder(app: AppHandle, id: String, delta: i32) -> Result<(), CmdError> {
    service(&app)?.reorder(&id, delta)?;
    announce(&app);
    Ok(())
}

/// Makes an item due now; also Retry for one that failed.
#[tauri::command(async)]
pub fn prompt_queue_send_now(app: AppHandle, id: String) -> Result<Item, CmdError> {
    let made = service(&app)?.send_now(&id)?;
    announce(&app);
    crate::automations::kick(&app);
    Ok(made)
}

/// How a send ended (the window's verified send).
#[tauri::command(async)]
pub fn prompt_queue_report(app: AppHandle, id: String, report: SendReport) -> Result<(), CmdError> {
    service(&app)?.report(&id, report)?;
    announce(&app);
    crate::automations::kick(&app);
    Ok(())
}

/// The window's live tabs, whether each agent is idle, and the 5-hour quota windows. Sent when they
/// change and at least every 30 s; a later change makes a pass run at once.
#[tauri::command(async)]
pub fn prompt_queue_facts(app: AppHandle, facts: Facts) -> Result<(), CmdError> {
    if service(&app)?.set_facts(facts) {
        crate::automations::kick(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    use xdev_automations::prompt_queue::{
        MAX_ITEMS_PER_TAB, MAX_PROMPT_BYTES, QuotaFact, Status, TabFact, When,
    };

    use super::*;

    const T0: i64 = 1_793_872_800_000;
    const MIN: i64 = 60_000;

    fn service_at(store: Store) -> (PromptQueueService, Arc<AtomicI64>) {
        let now = Arc::new(AtomicI64::new(T0));
        let clock = Arc::clone(&now);
        (
            PromptQueueService::new(store, move || clock.load(Ordering::SeqCst)),
            now,
        )
    }

    fn new(tab: &str, text: &str, when: WhenInput) -> NewItem {
        NewItem {
            tab_id: tab.into(),
            text: text.into(),
            when,
        }
    }

    fn ready(tabs: &[&str]) -> Facts {
        Facts {
            ready: true,
            tabs: tabs
                .iter()
                .map(|t| TabFact {
                    id: (*t).into(),
                    idle: true,
                })
                .collect(),
            quotas: vec![],
        }
    }

    fn code(e: CmdError) -> (&'static str, Option<String>) {
        (e.code, e.detail)
    }

    #[test]
    fn the_queue_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (svc, _) = service_at(Store::open(dir.path()));
        svc.add(new("a", "one", WhenInput::InMinutes { minutes: 5 }))
            .unwrap();
        svc.add(new("a", "two", WhenInput::Idle)).unwrap();
        let again = Store::open(dir.path());
        let texts: Vec<&str> = again
            .queue()
            .items
            .iter()
            .map(|i| i.text.as_str())
            .collect();
        assert_eq!(texts, ["one", "two"]);
        assert_eq!(again.queue().items[0].when, When::At { at: T0 + 5 * MIN });
    }

    #[test]
    fn a_send_in_flight_when_the_app_quit_pauses_its_tab_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let (svc, _) = service_at(Store::open(dir.path()));
        svc.add(new("a", "one", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        svc.set_facts(ready(&["a"]));
        assert_eq!(svc.tick().due.len(), 1);
        let reopened = Store::open(dir.path());
        assert_eq!(reopened.queue().items[0].status, Status::Unconfirmed);
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_the_queue_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), b"{ not json").unwrap();
        let store = Store::open(dir.path());
        assert!(store.queue().items.is_empty());
        assert!(dir.path().join("prompt-queue.json.bad").exists());
    }

    #[test]
    fn limits_come_back_as_too_large() {
        let (svc, _) = service_at(Store::memory());
        let big = "x".repeat(MAX_PROMPT_BYTES + 1);
        assert_eq!(
            code(svc.add(new("a", &big, WhenInput::Idle)).unwrap_err()),
            ("too_large", Some("prompt".into()))
        );
        for _ in 0..MAX_ITEMS_PER_TAB {
            svc.add(new("a", "x", WhenInput::Idle)).unwrap();
        }
        assert_eq!(
            code(svc.add(new("a", "x", WhenInput::Idle)).unwrap_err()),
            ("too_large", Some("items".into()))
        );
        assert_eq!(
            code(svc.add(new("b", " ", WhenInput::Idle)).unwrap_err()),
            ("bad_arg", Some("empty".into()))
        );
    }

    #[test]
    fn two_prompts_in_zero_minutes_go_one_after_the_other() {
        let (svc, _) = service_at(Store::memory());
        let a = svc
            .add(new("a", "first", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        let b = svc
            .add(new("a", "second", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        svc.set_facts(ready(&["a"]));
        let first = svc.tick();
        assert_eq!(first.due.iter().map(|i| &i.id).collect::<Vec<_>>(), [&a.id]);
        assert!(svc.tick().due.is_empty());
        svc.report(&a.id, SendReport::Sent).unwrap();
        let second = svc.tick();
        assert_eq!(
            second.due.iter().map(|i| &i.id).collect::<Vec<_>>(),
            [&b.id]
        );
        svc.report(&b.id, SendReport::Sent).unwrap();
        assert!(svc.list().is_empty());
    }

    #[test]
    fn nothing_is_due_without_a_fresh_report_from_the_window() {
        let (svc, now) = service_at(Store::memory());
        svc.add(new("a", "x", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        assert!(svc.tick().due.is_empty());
        svc.set_facts(ready(&["a"]));
        // The window stopped reporting.
        now.store(T0 + FACTS_TTL_MS + 1, Ordering::SeqCst);
        assert!(svc.tick().due.is_empty());
        svc.set_facts(ready(&["a"]));
        assert_eq!(svc.tick().due.len(), 1);
    }

    #[test]
    fn the_window_going_away_stops_the_queue_until_it_reports_again() {
        let (svc, _) = service_at(Store::memory());
        svc.add(new("a", "x", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        svc.set_facts(ready(&["a"]));
        svc.forget_facts();
        assert!(svc.tick().due.is_empty());
    }

    #[test]
    fn a_gone_tab_marks_the_item_and_sends_nothing() {
        let (svc, _) = service_at(Store::memory());
        svc.add(new("gone", "x", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        svc.set_facts(ready(&["other"]));
        let pass = svc.tick();
        assert!(pass.due.is_empty());
        assert!(pass.changed);
        assert_eq!(svc.list()[0].status, Status::TabClosed);
    }

    #[test]
    fn a_not_confirmed_send_pauses_and_retry_sends_it_again() {
        let (svc, _) = service_at(Store::memory());
        let a = svc
            .add(new("a", "first", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        svc.add(new("a", "second", WhenInput::InMinutes { minutes: 0 }))
            .unwrap();
        svc.set_facts(ready(&["a"]));
        svc.tick();
        svc.report(&a.id, SendReport::Unconfirmed).unwrap();
        assert!(svc.tick().due.is_empty());
        svc.send_now(&a.id).unwrap();
        assert_eq!(svc.tick().due[0].id, a.id);
    }

    #[test]
    fn a_wait_for_a_quota_with_an_unknown_reset_polls() {
        let (svc, now) = service_at(Store::memory());
        svc.add(new(
            "a",
            "x",
            WhenInput::AfterReset {
                quota: Some("main".into()),
                reset_at: None,
            },
        ))
        .unwrap();
        let facts = |used: f64| Facts {
            quotas: vec![QuotaFact {
                name: "main".into(),
                resets_at: None,
                utilization: Some(used),
            }],
            ..ready(&["a"])
        };
        svc.set_facts(facts(100.0));
        assert!(svc.tick().due.is_empty());
        now.store(T0 + MIN, Ordering::SeqCst);
        svc.set_facts(facts(10.0));
        assert!(svc.tick().due.is_empty(), "not looked at before 5 minutes");
        now.store(T0 + 5 * MIN, Ordering::SeqCst);
        svc.set_facts(facts(10.0));
        assert_eq!(svc.tick().due.len(), 1);
    }

    #[test]
    fn reorder_edit_and_delete_are_saved() {
        let dir = tempfile::tempdir().unwrap();
        let (svc, _) = service_at(Store::open(dir.path()));
        let a = svc.add(new("a", "1", WhenInput::Idle)).unwrap();
        let b = svc.add(new("a", "2", WhenInput::Idle)).unwrap();
        svc.reorder(&b.id, -1).unwrap();
        svc.update(&a.id, "one".into(), WhenInput::Idle).unwrap();
        let ids = |s: &Store| {
            s.queue()
                .items
                .iter()
                .map(|i| i.text.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&Store::open(dir.path())), ["2", "one"]);
        svc.delete(&b.id).unwrap();
        assert_eq!(ids(&Store::open(dir.path())), ["one"]);
        assert_eq!(code(svc.delete("nope").unwrap_err()), ("not_found", None));
    }

    #[test]
    fn a_save_that_fails_leaves_the_queue_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        // The file's place is a folder, so it cannot be written.
        fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
        let (svc, _) = service_at(Store {
            path: Some(dir.path().join(FILE_NAME)),
            queue: Queue::default(),
        });
        assert_eq!(
            svc.add(new("a", "x", WhenInput::Idle)).unwrap_err().code,
            "io"
        );
        assert!(svc.list().is_empty());
    }
}
