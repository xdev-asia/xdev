//! `<app config dir>/keybindings.json`: the person's shortcut overrides.
//! Rust only moves the text: it reads it, writes it atomically and says when
//! it changed. The UI parses it (`keys/keybindingsFile.ts`), so the page,
//! the keymap and the diagnostics share one parser.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::CmdError;

pub const FILE_NAME: &str = "keybindings.json";
/// Emitted after our own write and when the file changes on disk, with a
/// `KeybindingsChanged` payload.
pub const CHANGED_EVENT: &str = "keybindings://changed";
/// A bigger text is refused: no real keymap comes near it.
const MAX_BYTES: usize = 1024 * 1024;
const DEBOUNCE: Duration = Duration::from_millis(200);
/// What reveal writes when there is no file yet.
const EMPTY_FILE: &str = "{\n  \"version\": 1,\n  \"keybindings\": {}\n}\n";

/// What `keybindings_read` returns. `text` is `None` when there is no file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsText {
    pub text: Option<String>,
    pub path: String,
}

/// The payload of `CHANGED_EVENT`: the file as it is now.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsChanged {
    pub text: Option<String>,
}

/// The text last sent with `CHANGED_EVENT` (outer `None`: nothing sent yet).
/// The watcher sends nothing when the file still holds it, so our own write
/// is announced once, not twice. Held while writing, so the watcher never
/// reads half of a write's bookkeeping.
#[derive(Default, Clone)]
pub struct LastSent(Arc<Mutex<Option<Option<String>>>>);

impl LastSent {
    /// Records `text`; false when it was already the last one sent.
    fn update(&self, text: &Option<String>) -> bool {
        let mut last = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if last.as_ref() == Some(text) {
            return false;
        }
        *last = Some(text.clone());
        true
    }
}

fn io_err(e: impl ToString) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

fn file_path(app: &AppHandle) -> Result<PathBuf, CmdError> {
    Ok(app.path().app_config_dir().map_err(io_err)?.join(FILE_NAME))
}

/// The file's text, `None` when it is missing.
fn read_at(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes a temp file beside `path`, then renames it over, so a crash leaves
/// the old file or the new one, never half of one.
fn write_at(path: &Path, text: &str) -> Result<(), CmdError> {
    if text.len() > MAX_BYTES {
        return Err(CmdError {
            code: "bad_arg",
            detail: Some(format!("keybindings.json is over {MAX_BYTES} bytes")),
        });
    }
    let dir = path.parent().ok_or_else(|| io_err("no folder"))?;
    fs::create_dir_all(dir).map_err(io_err)?;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{FILE_NAME}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = File::create_new(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(io_err)
}

/// Writes the empty version-1 file when there is none; never overwrites.
/// True when it wrote one.
fn create_if_missing(path: &Path) -> io::Result<bool> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    match File::create_new(path) {
        Ok(mut f) => {
            f.write_all(EMPTY_FILE.as_bytes())?;
            f.sync_all()?;
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// The file's text, `None` when it is missing, and where it lives.
#[tauri::command(async)]
pub fn keybindings_read(app: AppHandle) -> Result<KeybindingsText, CmdError> {
    let path = file_path(&app)?;
    Ok(KeybindingsText {
        text: read_at(&path).map_err(io_err)?,
        path: path.to_string_lossy().into_owned(),
    })
}

/// Replaces the whole file through a temp file; rejects with `bad_arg` past
/// 1 MiB. Emits `CHANGED_EVENT`.
#[tauri::command(async)]
pub fn keybindings_write(
    app: AppHandle,
    last: State<'_, LastSent>,
    text: String,
) -> Result<(), CmdError> {
    let path = file_path(&app)?;
    let mut sent = last.0.lock().unwrap_or_else(PoisonError::into_inner);
    write_at(&path, &text)?;
    *sent = Some(Some(text.clone()));
    drop(sent);
    // Fails only once the app is shutting down; nobody is listening.
    let _ = app.emit(CHANGED_EVENT, KeybindingsChanged { text: Some(text) });
    Ok(())
}

/// Opens the config folder; writes an empty version-1 file first when there
/// is none.
#[tauri::command]
pub fn keybindings_reveal(app: AppHandle) -> Result<(), CmdError> {
    let path = file_path(&app)?;
    create_if_missing(&path).map_err(io_err)?;
    let dir = path.parent().ok_or_else(|| io_err("no folder"))?;
    crate::reveal::reveal(dir, false).map_err(io_err)
}

/// Watching stops when this is dropped; kept in app state for the app's life.
pub struct KeybindingsWatcher {
    _debouncer: Mutex<Debouncer<RecommendedWatcher, NoCache>>,
}

/// Emits `CHANGED_EVENT` when `keybindings.json` in the app config folder
/// changes on disk, but not for a text this app already sent.
pub fn watch(app: AppHandle, last: LastSent) -> notify::Result<KeybindingsWatcher> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| notify::Error::generic(&e.to_string()))?;
    start(dir, last, move |text| {
        let _ = app.emit(CHANGED_EVENT, KeybindingsChanged { text });
    })
}

fn start(
    dir: PathBuf,
    last: LastSent,
    on_change: impl Fn(Option<String>) + Send + 'static,
) -> notify::Result<KeybindingsWatcher> {
    fs::create_dir_all(&dir).map_err(notify::Error::io)?;
    let file = dir.join(FILE_NAME);
    // What is on disk now is what the UI reads first; no event for it.
    if let Ok(text) = read_at(&file) {
        last.update(&text);
    }
    let handler = move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let ours = events
            .iter()
            .flat_map(|e| e.paths.iter())
            .any(|p| p.file_name().is_some_and(|n| n == FILE_NAME));
        if !ours {
            return;
        }
        // A file being replaced may not read; the next event reads it.
        let Ok(text) = read_at(&file) else { return };
        if last.update(&text) {
            on_change(text);
        }
    };
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        DEBOUNCE,
        None,
        handler,
        NoCache::new(),
        notify::Config::default(),
    )?;
    debouncer.watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(KeybindingsWatcher {
        _debouncer: Mutex::new(debouncer),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_missing_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_at(&dir.path().join(FILE_NAME)).unwrap(), None);
    }

    #[test]
    fn a_write_reads_back_the_same_text_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join(FILE_NAME);
        let text = "{\n  // mine\n  \"keybindings\": { \"tab.new\": \"Ctrl+Alt+N\" },\n}\n";
        write_at(&path, text).unwrap();
        assert_eq!(read_at(&path).unwrap().as_deref(), Some(text));
        write_at(&path, "{}").unwrap();
        assert_eq!(read_at(&path).unwrap().as_deref(), Some("{}"));
        assert_eq!(names(path.parent().unwrap()), vec![FILE_NAME.to_string()]);
    }

    #[test]
    fn a_text_over_one_mib_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write_at(&path, "{}").unwrap();
        let err = write_at(&path, &"x".repeat(2 * 1024 * 1024)).unwrap_err();
        assert_eq!(err.code, "bad_arg");
        assert_eq!(read_at(&path).unwrap().as_deref(), Some("{}"));
        assert_eq!(names(dir.path()), vec![FILE_NAME.to_string()]);
    }

    #[test]
    fn exactly_one_mib_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write_at(&path, &"x".repeat(MAX_BYTES)).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_BYTES as u64);
    }

    #[test]
    fn reveal_creates_the_empty_file_once_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join(FILE_NAME);
        assert!(create_if_missing(&path).unwrap());
        let made = read_at(&path).unwrap().unwrap();
        let json: serde_json::Value = serde_json::from_str(&made).unwrap();
        assert_eq!(json, serde_json::json!({ "version": 1, "keybindings": {} }));
        fs::write(&path, "{ \"keybindings\": { \"tab.new\": [] } }").unwrap();
        assert!(!create_if_missing(&path).unwrap());
        assert_eq!(
            read_at(&path).unwrap().as_deref(),
            Some("{ \"keybindings\": { \"tab.new\": [] } }")
        );
    }

    #[test]
    fn last_sent_skips_a_repeat() {
        let last = LastSent::default();
        assert!(last.update(&None));
        assert!(!last.update(&None));
        assert!(last.update(&Some("a".into())));
        assert!(!last.update(&Some("a".into())));
        assert!(last.update(&Some("b".into())));
    }

    #[test]
    fn the_watcher_sends_an_edit_on_disk_but_not_our_own_write_or_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let last = LastSent::default();
        let (tx, rx) = mpsc::channel();
        let _watcher = start(dir.path().to_path_buf(), last.clone(), move |text| {
            let _ = tx.send(text);
        })
        .unwrap();

        // Another file in the folder (settings.json lives here too).
        fs::write(dir.path().join("settings.json"), "{}").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());

        // Our own write, recorded the way `keybindings_write` records it.
        {
            let mut sent = last.0.lock().unwrap();
            write_at(&path, "{\"version\":1}").unwrap();
            *sent = Some(Some("{\"version\":1}".into()));
        }
        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());

        // A person edits the file.
        fs::write(&path, "{\"version\":1,\"keybindings\":{}}").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(got.as_deref(), Some("{\"version\":1,\"keybindings\":{}}"));
    }
}
