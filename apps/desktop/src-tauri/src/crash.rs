//! Crash reports kept on this machine: render errors the UI reports, and Rust
//! panics. Nothing is sent anywhere; a person copies the text out. Reports
//! sit in `<local>/crash-reports.json` (at most five, newest first) and carry
//! the last 30 breadcrumbs, so a report shows what happened just before.

use crate::commands::CmdError;
use crate::redact::redact_text;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub const MAX_REPORTS: usize = 5;
pub const MAX_BREADCRUMBS: usize = 30;
pub const FILE: &str = "crash-reports.json";
const MAX_NAME: usize = 80;
const MAX_MESSAGE: usize = 500;
const MAX_STACK: usize = 4000;
const MAX_STACK_LINES: usize = 12;
const MAX_VALUE: usize = 240;
const MAX_DATA: usize = 8;
/// Reports of one crash storm are dismissed together within this window.
const RELATED_MS: i64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum CrashStatus {
    Pending,
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum CrashSource {
    Main,
    Renderer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CrashDetail {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Breadcrumb {
    pub at: i64,
    pub name: String,
    pub data: Vec<CrashDetail>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub id: String,
    pub created_at: i64,
    pub status: CrashStatus,
    pub source: CrashSource,
    pub process: String,
    pub reason: String,
    pub exit_code: Option<i32>,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
    pub details: Vec<CrashDetail>,
    pub breadcrumbs: Vec<Breadcrumb>,
}

/// What the UI sends when a boundary catches a render error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RenderCrash {
    pub boundary: String,
    pub surface: String,
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
    pub context: Vec<CrashDetail>,
}

#[derive(Serialize, Deserialize)]
struct Store {
    reports: Vec<CrashReport>,
}

fn store_error(detail: impl ToString) -> CmdError {
    CmdError {
        code: "crash_store",
        detail: Some(detail.to_string()),
    }
}

// ---- bounds ---------------------------------------------------------------

/// Cuts `s` to `max` characters; a cut ends in `...`.
pub(crate) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep: String = s.chars().take(max.saturating_sub(3)).collect();
    format!("{keep}...")
}

/// At most 12 lines and 4000 characters.
fn clip_stack(s: &str) -> String {
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() > MAX_STACK_LINES {
        let mut cut = lines[..MAX_STACK_LINES].join("\n");
        cut.push_str("\n...");
        clip(&cut, MAX_STACK)
    } else {
        clip(s, MAX_STACK)
    }
}

fn detail(key: &str, value: &str, home: Option<&Path>) -> CrashDetail {
    let value = if key.to_lowercase().ends_with("path") {
        "[redacted-path]".to_string()
    } else {
        clip(&redact_text(value, home), MAX_VALUE)
    };
    CrashDetail {
        key: clip(key, MAX_NAME),
        value,
    }
}

// ---- breadcrumbs ----------------------------------------------------------

/// The last events before a crash, newest last. Full: the oldest entry of
/// the name that has the most entries goes, so one noisy name cannot push
/// everything else out.
#[derive(Default)]
pub struct Breadcrumbs(Mutex<VecDeque<Breadcrumb>>);

impl Breadcrumbs {
    pub fn push(&self, at: i64, name: &str, data: &[CrashDetail], home: Option<&Path>) {
        let crumb = Breadcrumb {
            at,
            name: clip(name, MAX_NAME),
            data: data
                .iter()
                .take(MAX_DATA)
                .map(|d| detail(&d.key, &d.value, home))
                .collect(),
        };
        let mut ring = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if ring.len() >= MAX_BREADCRUMBS {
            evict(&mut ring);
        }
        ring.push_back(crumb);
    }

    pub fn snapshot(&self) -> Vec<Breadcrumb> {
        let ring = self.0.lock().unwrap_or_else(|p| p.into_inner());
        ring.iter().cloned().collect()
    }

    /// For the panic hook, which may run while this lock is held.
    fn try_snapshot(&self) -> Vec<Breadcrumb> {
        match self.0.try_lock() {
            Ok(ring) => ring.iter().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }
}

fn evict(ring: &mut VecDeque<Breadcrumb>) {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for crumb in ring.iter() {
        match counts.iter_mut().find(|(n, _)| *n == crumb.name) {
            Some(entry) => entry.1 += 1,
            None => counts.push((&crumb.name, 1)),
        }
    }
    // The first name to reach the highest count wins a tie.
    let busiest = counts
        .iter()
        .fold(None::<(&str, usize)>, |best, &(n, c)| match best {
            Some((_, bc)) if bc >= c => best,
            _ => Some((n, c)),
        })
        .map(|(n, _)| n.to_string());
    if let Some(name) = busiest
        && let Some(i) = ring.iter().position(|c| c.name == name)
    {
        ring.remove(i);
    }
}

// ---- the store ------------------------------------------------------------

pub(crate) fn store_path(local: &Path) -> PathBuf {
    local.join(FILE)
}

/// A missing file is no reports; an unreadable one is an error.
pub(crate) fn load(path: &Path) -> Result<Vec<CrashReport>, CmdError> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Store>(&text)
            .map(|s| s.reports)
            .map_err(store_error),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(store_error(e)),
    }
}

fn save(path: &Path, reports: &[CrashReport]) -> Result<(), CmdError> {
    let text = serde_json::to_string_pretty(&Store {
        reports: reports.to_vec(),
    })
    .map_err(store_error)?;
    // Windows can hold the file for a moment (a scanner, an indexer).
    let mut last = Ok(());
    for attempt in 0..3 {
        match crate::atomic::write_atomic(path, text.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                last = Err(store_error(e));
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            Err(e) => return Err(store_error(e)),
        }
    }
    last
}

/// Held around every read-change-write of the store, so two writers cannot
/// each read the old file and drop the other's change.
static STORE: Mutex<()> = Mutex::new(());

fn lock_store() -> MutexGuard<'static, ()> {
    STORE.lock().unwrap_or_else(|p| p.into_inner())
}

/// For the panic hook: waits a short, bounded time, then gives up, so a
/// panic never hangs on a lock held by a thread that is itself stuck.
fn try_lock_store() -> Option<MutexGuard<'static, ()>> {
    for _ in 0..50 {
        match STORE.try_lock() {
            Ok(guard) => return Some(guard),
            Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
    None
}

/// Adds a report, newest first, keeping five. A file that is not valid JSON
/// is replaced: a broken store must not stop the next crash from being kept.
/// A read error (a file held for a moment) is returned instead, because
/// starting fresh would wipe the stored reports.
pub(crate) fn record(path: &Path, report: CrashReport) -> Result<(), CmdError> {
    let _guard = lock_store();
    record_locked(path, report)
}

fn record_locked(path: &Path, report: CrashReport) -> Result<(), CmdError> {
    let mut reports = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Store>(&text)
            .map(|s| s.reports)
            .unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(store_error(e)),
    };
    reports.insert(0, report);
    reports.truncate(MAX_REPORTS);
    save(path, &reports)
}

/// The newest report, of any status.
pub(crate) fn latest(path: &Path) -> Result<Option<CrashReport>, CmdError> {
    Ok(load(path)?.into_iter().next())
}

/// The newest pending report, marked dismissed at once so it prompts once.
/// The returned copy still says pending.
pub(crate) fn take_pending(path: &Path) -> Result<Option<CrashReport>, CmdError> {
    let _guard = lock_store();
    let mut reports = load(path)?;
    let Some(report) = reports
        .iter_mut()
        .find(|r| r.status == CrashStatus::Pending)
    else {
        return Ok(None);
    };
    let taken = report.clone();
    report.status = CrashStatus::Dismissed;
    save(path, &reports)?;
    Ok(Some(taken))
}

/// Dismisses `id`, and pending reports of the same storm: the same reason,
/// exit code, version and platform within five seconds.
pub(crate) fn dismiss(path: &Path, id: &str) -> Result<(), CmdError> {
    let _guard = lock_store();
    let mut reports = load(path)?;
    let Some(target) = reports.iter().find(|r| r.id == id).cloned() else {
        return Ok(());
    };
    for r in reports.iter_mut() {
        let related = r.status == CrashStatus::Pending
            && r.reason == target.reason
            && r.exit_code == target.exit_code
            && r.app_version == target.app_version
            && r.platform == target.platform
            && (r.created_at - target.created_at).abs() <= RELATED_MS;
        if r.id == id || related {
            r.status = CrashStatus::Dismissed;
        }
    }
    save(path, &reports)
}

// ---- building reports -----------------------------------------------------

fn base(id: String, now: i64, source: CrashSource, process: &str, reason: &str) -> CrashReport {
    CrashReport {
        id,
        created_at: now,
        status: CrashStatus::Pending,
        source,
        process: process.to_string(),
        reason: reason.to_string(),
        exit_code: None,
        app_version: xdev_core::version().to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        details: Vec::new(),
        breadcrumbs: Vec::new(),
    }
}

/// A report for a render error a boundary caught.
pub(crate) fn render_report(
    crash: &RenderCrash,
    crumbs: Vec<Breadcrumb>,
    id: String,
    now: i64,
    home: Option<&Path>,
) -> CrashReport {
    let mut report = base(
        id,
        now,
        CrashSource::Renderer,
        "react-render",
        "react-error-boundary",
    );
    let mut details = vec![
        detail("boundary", &crash.boundary, home),
        detail("surface", &crash.surface, home),
        detail("error_name", &crash.name, home),
        CrashDetail {
            key: "message".into(),
            value: clip(&redact_text(&crash.message, home), MAX_MESSAGE),
        },
    ];
    for (key, value) in [
        ("stack", &crash.stack),
        ("component_stack", &crash.component_stack),
    ] {
        if let Some(text) = value {
            details.push(CrashDetail {
                key: key.into(),
                value: clip_stack(&redact_text(text, home)),
            });
        }
    }
    details.extend(
        crash
            .context
            .iter()
            .take(MAX_DATA)
            .map(|d| detail(&d.key, &d.value, home)),
    );
    report.details = details;
    report.breadcrumbs = crumbs;
    report
}

/// A report for a Rust panic, from the parts a panic hook can see.
pub(crate) fn panic_report(
    location: Option<&str>,
    thread: &str,
    message: &str,
    crumbs: Vec<Breadcrumb>,
    id: String,
    now: i64,
    home: Option<&Path>,
) -> CrashReport {
    let mut report = base(id, now, CrashSource::Main, "app", "panic");
    report.details = vec![
        // The key has no `path` suffix on purpose: a source location is
        // code, not a user path, and it is what makes the report useful.
        detail("location", location.unwrap_or("unknown"), home),
        detail("thread", thread, home),
        CrashDetail {
            key: "message".into(),
            value: clip(&redact_text(message, home), MAX_MESSAGE),
        },
    ];
    report.breadcrumbs = crumbs;
    report
}

/// Writes a report for every panic, then runs the hook that was there. It
/// never panics itself, and never waits on the breadcrumb lock.
pub fn install_panic_hook(local: Option<PathBuf>, crumbs: Arc<Breadcrumbs>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic without a message".to_string());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
            let thread = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let home = crate::applog::home_dir();
            let now = crate::workspace::clock().0;
            let report = panic_report(
                location.as_deref(),
                &thread,
                &message,
                crumbs.try_snapshot(),
                uuid::Uuid::new_v4().to_string(),
                now,
                home.as_deref(),
            );
            crate::applog::error(
                "panic",
                &format!(
                    "{} at {}",
                    message,
                    location.as_deref().unwrap_or("unknown")
                ),
            );
            if let Some(local) = &local
                && let Some(_guard) = try_lock_store()
            {
                let _ = record_locked(&store_path(local), report);
            }
        }));
        previous(info);
    }));
}

// ---- commands -------------------------------------------------------------

fn store_file(app: &tauri::AppHandle) -> Result<PathBuf, CmdError> {
    use tauri::Manager;
    let state = app.state::<crate::commands::AppState>();
    Ok(store_path(crate::accounts::local_dir(&state)?))
}

/// A boundary caught a render error: keep a report and answer it so the UI
/// can show it at once.
#[tauri::command]
pub fn crash_record_render(
    app: tauri::AppHandle,
    crash: RenderCrash,
) -> Result<Option<CrashReport>, CmdError> {
    use tauri::Manager;
    let path = store_file(&app)?;
    let home = crate::applog::home_dir();
    let report = render_report(
        &crash,
        app.state::<Arc<Breadcrumbs>>().snapshot(),
        uuid::Uuid::new_v4().to_string(),
        crate::workspace::clock().0,
        home.as_deref(),
    );
    crate::applog::error(
        "render",
        &format!("{} in {}: {}", crash.name, crash.boundary, crash.message),
    );
    record(&path, report.clone())?;
    Ok(Some(report))
}

#[tauri::command]
pub fn crash_breadcrumb(app: tauri::AppHandle, name: String, data: Vec<CrashDetail>) {
    use tauri::Manager;
    app.state::<Arc<Breadcrumbs>>().push(
        crate::workspace::clock().0,
        &name,
        &data,
        crate::applog::home_dir().as_deref(),
    );
}

/// The newest pending report, once: it is marked dismissed as it is taken.
#[tauri::command]
pub fn crash_take_pending(app: tauri::AppHandle) -> Result<Option<CrashReport>, CmdError> {
    take_pending(&store_file(&app)?)
}

/// The newest report of any status.
#[tauri::command]
pub fn crash_latest(app: tauri::AppHandle) -> Result<Option<CrashReport>, CmdError> {
    latest(&store_file(&app)?)
}

#[tauri::command]
pub fn crash_dismiss(app: tauri::AppHandle, id: String) -> Result<(), CmdError> {
    dismiss(&store_file(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dirs::long_temp_dir;

    fn report(id: &str, at: i64) -> CrashReport {
        let mut r = base(id.into(), at, CrashSource::Main, "app", "panic");
        r.details = vec![CrashDetail {
            key: "message".into(),
            value: "boom".into(),
        }];
        r
    }

    fn crash() -> RenderCrash {
        RenderCrash {
            boundary: "sidebar.worktrees".into(),
            surface: "sidebar".into(),
            name: "TypeError".into(),
            message: "x is undefined".into(),
            stack: Some("at a\nat b".into()),
            component_stack: None,
            context: vec![],
        }
    }

    fn value<'a>(r: &'a CrashReport, key: &str) -> &'a str {
        &r.details.iter().find(|d| d.key == key).unwrap().value
    }

    #[test]
    fn keeps_five_newest_first() {
        let dir = long_temp_dir("crash");
        let path = store_path(dir.path());
        for i in 0..7 {
            record(&path, report(&format!("r{i}"), i)).unwrap();
        }
        let ids: Vec<_> = load(&path).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["r6", "r5", "r4", "r3", "r2"]);
    }

    #[test]
    fn round_trips_and_is_pretty_printed() {
        let dir = long_temp_dir("crash");
        let path = store_path(dir.path());
        let r = render_report(&crash(), vec![], "a".into(), 5, None);
        record(&path, r.clone()).unwrap();
        assert_eq!(load(&path).unwrap(), vec![r]);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("{\n  \"reports\": ["));
        assert!(text.contains("\"createdAt\": 5"));
        // No temp files left behind.
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn a_broken_file_is_an_error_and_the_next_record_starts_fresh() {
        let dir = long_temp_dir("crash");
        let path = store_path(dir.path());
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path).unwrap_err().code, "crash_store");
        assert_eq!(latest(&path).unwrap_err().code, "crash_store");
        record(&path, report("fresh", 1)).unwrap();
        let got = load(&path).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "fresh");
    }

    #[test]
    fn a_missing_file_is_no_reports() {
        let dir = long_temp_dir("crash");
        let path = store_path(dir.path());
        assert!(load(&path).unwrap().is_empty());
        assert_eq!(latest(&path).unwrap(), None);
        assert_eq!(take_pending(&path).unwrap(), None);
    }

    #[test]
    fn values_are_bounded_and_clipped_with_dots() {
        let long = "m".repeat(900);
        let stack: String = (0..30).map(|i| format!("line {i}\n")).collect();
        let mut c = crash();
        c.message = long;
        c.stack = Some(stack);
        c.component_stack = Some("c".repeat(9000));
        c.surface = "s".repeat(500);
        let r = render_report(&c, vec![], "a".into(), 1, None);
        let message = value(&r, "message");
        assert_eq!(message.chars().count(), 500);
        assert!(message.ends_with("..."));
        let stack = value(&r, "stack");
        assert_eq!(stack.lines().count(), 13);
        assert!(stack.ends_with("\n..."));
        assert!(stack.contains("line 11") && !stack.contains("line 12"));
        let comp = value(&r, "component_stack");
        assert_eq!(comp.chars().count(), 4000);
        assert!(comp.ends_with("..."));
        let surface = value(&r, "surface");
        assert_eq!(surface.chars().count(), 240);
        assert!(surface.ends_with("..."));
    }

    #[test]
    fn secrets_paths_and_home_are_redacted_at_record_time() {
        let home = Path::new("/home/me");
        let mut c = crash();
        c.message = "failed token=abc123 in /home/me/code".into();
        c.context = vec![CrashDetail {
            key: "worktreePath".into(),
            value: "/home/me/code".into(),
        }];
        let r = render_report(&c, vec![], "a".into(), 1, Some(home));
        assert_eq!(value(&r, "message"), "failed token=[redacted] in ~/code");
        assert_eq!(value(&r, "worktreePath"), "[redacted-path]");
    }

    #[test]
    fn dismiss_takes_related_pending_reports_within_five_seconds() {
        let dir = long_temp_dir("crash");
        let path = store_path(dir.path());
        record(&path, report("a", 1_000)).unwrap();
        record(&path, report("b", 3_000)).unwrap();
        record(&path, report("far", 60_000)).unwrap();
        let mut other = report("other", 2_000);
        other.reason = "different".into();
        record(&path, other).unwrap();
        dismiss(&path, "b").unwrap();
        let status = |id: &str| {
            load(&path)
                .unwrap()
                .into_iter()
                .find(|r| r.id == id)
                .unwrap()
                .status
        };
        assert_eq!(status("b"), CrashStatus::Dismissed);
        assert_eq!(status("a"), CrashStatus::Dismissed);
        assert_eq!(status("far"), CrashStatus::Pending);
        assert_eq!(status("other"), CrashStatus::Pending);
        // An unknown id changes nothing and is not an error.
        dismiss(&path, "nope").unwrap();
    }

    #[test]
    fn take_pending_marks_dismissed_and_answers_once() {
        let dir = long_temp_dir("crash");
        let path = store_path(dir.path());
        record(&path, report("a", 1)).unwrap();
        let taken = take_pending(&path).unwrap().unwrap();
        assert_eq!(taken.id, "a");
        assert_eq!(taken.status, CrashStatus::Pending);
        assert_eq!(take_pending(&path).unwrap(), None);
        // The latest report is still there, of any status.
        let last = latest(&path).unwrap().unwrap();
        assert_eq!(last.status, CrashStatus::Dismissed);
    }

    #[test]
    fn the_ring_evicts_from_the_busiest_name() {
        let ring = Breadcrumbs::default();
        for i in 0..MAX_BREADCRUMBS as i64 {
            let name = if i == 0 { "boot" } else { "click" };
            ring.push(i, name, &[], None);
        }
        assert_eq!(ring.snapshot().len(), MAX_BREADCRUMBS);
        ring.push(100, "error", &[], None);
        let got = ring.snapshot();
        assert_eq!(got.len(), MAX_BREADCRUMBS);
        // The rare first entry survives; the oldest `click` went.
        assert_eq!(got[0].name, "boot");
        assert_eq!(got[1].at, 2);
        assert_eq!(got.last().unwrap().name, "error");
    }

    #[test]
    fn crumb_names_and_data_are_capped() {
        let ring = Breadcrumbs::default();
        let data: Vec<CrashDetail> = (0..20)
            .map(|i| CrashDetail {
                key: format!("k{i}"),
                value: "v".repeat(400),
            })
            .collect();
        ring.push(1, &"n".repeat(200), &data, None);
        let crumb = &ring.snapshot()[0];
        assert_eq!(crumb.name.chars().count(), 80);
        assert_eq!(crumb.data.len(), 8);
        assert_eq!(crumb.data[0].value.chars().count(), 240);
    }

    #[test]
    fn concurrent_records_all_land() {
        let dir = long_temp_dir("crash-lock");
        let path = Arc::new(store_path(dir.path()));
        let handles: Vec<_> = (0..MAX_REPORTS)
            .map(|i| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    let r = panic_report(
                        None,
                        "t",
                        &format!("m{i}"),
                        vec![],
                        format!("id{i}"),
                        i as i64,
                        None,
                    );
                    record(&path, r).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(load(&path).unwrap().len(), MAX_REPORTS);
    }

    #[test]
    fn a_read_error_is_returned_not_treated_as_empty() {
        let dir = long_temp_dir("crash-io");
        // A folder where the file should be: reading it fails, and it is
        // not a missing file or bad JSON.
        let path = store_path(dir.path());
        std::fs::create_dir(&path).unwrap();
        let r = panic_report(None, "t", "m", vec![], "id".into(), 1, None);
        assert!(record(&path, r).is_err());
    }

    #[test]
    fn a_panic_report_has_location_thread_and_message() {
        let r = panic_report(
            Some("src/a.rs:1:2"),
            "main",
            "oops",
            vec![],
            "id".into(),
            9,
            None,
        );
        assert_eq!(r.source, CrashSource::Main);
        assert_eq!((r.process.as_str(), r.reason.as_str()), ("app", "panic"));
        assert_eq!(value(&r, "location"), "src/a.rs:1:2");
        assert_eq!(value(&r, "thread"), "main");
        assert_eq!(value(&r, "message"), "oops");
    }

    #[test]
    fn the_hook_writes_a_report_for_a_panicking_thread() {
        let dir = long_temp_dir("crash");
        let local = dir.path().to_path_buf();
        let crumbs = Arc::new(Breadcrumbs::default());
        crumbs.push(1, "before", &[], None);
        install_panic_hook(Some(local.clone()), crumbs);
        let path = store_path(&local);
        let mut found = None;
        // The hook skips the write while another test holds the store lock, so panic again
        // until a report lands.
        for _ in 0..40 {
            let handle = std::thread::Builder::new()
                .name("hook-test".into())
                .spawn(|| panic!("hook test panic"))
                .unwrap();
            assert!(handle.join().is_err());
            if let Ok(reports) = load(&path)
                && let Some(r) = reports
                    .into_iter()
                    .find(|r| value(r, "message") == "hook test panic")
            {
                found = Some(r);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Back to the default hook before the temp folder goes away.
        let _ = std::panic::take_hook();
        let r = found.expect("a panic report within four seconds");
        assert_eq!(value(&r, "message"), "hook test panic");
        assert_eq!(value(&r, "thread"), "hook-test");
        assert_eq!(r.breadcrumbs[0].name, "before");
    }
}
