//! Watches `<local_dir>/hooks/`, where `xdev agent-hook` appends one line per
//! event to `<pty_id>.jsonl`, and turns each new line into a `pty://hook`
//! event. Lines already there when the app starts are not replayed.

use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use xdev_agent::{HookDetail, HookEvent, HookLine, valid_pty_id, valid_session_id};

/// A hook writes one short line; anything longer is not one of ours.
const MAX_LINE: usize = 4096;

const DEBOUNCE: Duration = Duration::from_millis(100);

/// Payload of the `pty://hook` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtyHook {
    pub id: String,
    pub event: HookEvent,
    pub at: i64,
    pub detail: Option<HookDetail>,
    /// The agent's own session id, when its hook sent one.
    pub session: Option<String>,
}

/// How far a hook file has been read.
#[derive(Debug, Default, Clone, Copy)]
struct Pos {
    offset: u64,
    /// Inside a line that grew past `MAX_LINE`: drop bytes up to its newline.
    skipping: bool,
}

/// Reads the complete new lines of each hook file. Offsets are kept per pane
/// id, not per path: the watched folder is flat, and the OS may spell the
/// same file another way (macOS reports `/private/var/...` for `/var/...`).
#[derive(Debug, Default)]
pub struct HookReader {
    offsets: HashMap<String, Pos>,
}

impl HookReader {
    /// Starts every hook file already in `dir` at its current end.
    pub fn prime(&mut self, dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Some(id) = pty_id_of(&entry.path()) else {
                continue;
            };
            if let Ok(meta) = entry.metadata() {
                let pos = Pos {
                    offset: meta.len(),
                    skipping: false,
                };
                self.offsets.insert(id, pos);
            }
        }
    }

    /// The hooks in the lines of `file` completed since the last read. A
    /// partial line waits for its newline; a junk or overlong line is
    /// skipped; a file shorter than what was read starts over.
    pub fn read(&mut self, file: &Path) -> Vec<PtyHook> {
        let Some(id) = pty_id_of(file) else {
            return Vec::new();
        };
        let Ok(mut handle) = File::open(file) else {
            return Vec::new();
        };
        let Ok(len) = handle.metadata().map(|m| m.len()) else {
            return Vec::new();
        };
        let pos = self.offsets.entry(id.clone()).or_default();
        if len < pos.offset {
            *pos = Pos::default();
        }
        if len == pos.offset {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if handle.seek(SeekFrom::Start(pos.offset)).is_err()
            || handle.read_to_end(&mut bytes).is_err()
        {
            return Vec::new();
        }
        let mut hooks = Vec::new();
        let mut start = 0;
        while let Some(n) = bytes[start..].iter().position(|&b| b == b'\n') {
            let line = &bytes[start..start + n];
            start += n + 1;
            if std::mem::take(&mut pos.skipping) {
                continue;
            }
            if let Some(hook) = parse(&id, line) {
                hooks.push(hook);
            }
        }
        // The rest is a line still being written: wait for it, unless it is
        // already too long to be a hook line.
        if bytes.len() - start > MAX_LINE {
            start = bytes.len();
            pos.skipping = true;
        }
        pos.offset += start as u64;
        hooks
    }
}

/// The pane id a hook file belongs to: `<uuid>.jsonl`, nothing else.
fn pty_id_of(path: &Path) -> Option<String> {
    if path.extension()? != "jsonl" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    valid_pty_id(stem).then(|| stem.to_owned())
}

fn parse(id: &str, line: &[u8]) -> Option<PtyHook> {
    if line.len() > MAX_LINE {
        return None;
    }
    let line: HookLine = serde_json::from_slice(line).ok()?;
    (line.v == 1).then(|| PtyHook {
        id: id.to_owned(),
        event: line.event,
        at: line.at,
        detail: line.detail,
        session: line.session.filter(|s| valid_session_id(s)),
    })
}

/// Watching stops when this is dropped; kept in app state for the app's life.
pub struct HookWatcher {
    _debouncer: Mutex<Debouncer<RecommendedWatcher, NoCache>>,
}

/// Makes `dir` if missing and emits `pty://hook` for every new hook line.
pub fn watch(app: AppHandle, dir: PathBuf) -> notify::Result<HookWatcher> {
    start(dir, move |hook| {
        let _ = app.emit("pty://hook", hook);
    })
}

fn start(dir: PathBuf, on_hook: impl Fn(PtyHook) + Send + 'static) -> notify::Result<HookWatcher> {
    std::fs::create_dir_all(&dir).map_err(notify::Error::io)?;
    let mut reader = HookReader::default();
    reader.prime(&dir);
    let handler = move |res: DebounceEventResult| {
        // An error loses nothing: the next change reads from the kept offset.
        let Ok(events) = res else { return };
        let files: BTreeSet<&PathBuf> = events.iter().flat_map(|e| e.paths.iter()).collect();
        for file in files {
            for hook in reader.read(file) {
                on_hook(hook);
            }
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
    Ok(HookWatcher {
        _debouncer: Mutex::new(debouncer),
    })
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::mpsc;

    use super::*;

    const ID: &str = "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d";

    fn file(dir: &Path) -> PathBuf {
        dir.join(format!("{ID}.jsonl"))
    }

    fn append(path: &Path, text: &str) {
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    fn line(event: &str, at: i64) -> String {
        format!("{{\"v\":1,\"event\":\"{event}\",\"at\":{at}}}\n")
    }

    fn hook(event: HookEvent, at: i64) -> PtyHook {
        PtyHook {
            id: ID.to_owned(),
            event,
            at,
            detail: None,
            session: None,
        }
    }

    #[test]
    fn reader_reads_new_lines_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut reader = HookReader::default();
        append(&path, &(line("prompt", 1) + &line("turn-done", 2)));
        assert_eq!(
            reader.read(&path),
            [hook(HookEvent::Prompt, 1), hook(HookEvent::TurnDone, 2)]
        );
        assert!(reader.read(&path).is_empty());
    }

    #[test]
    fn reader_waits_for_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut reader = HookReader::default();
        let full = line("needs-input", 3);
        let (head, tail) = full.split_at(10);
        append(&path, head);
        assert!(reader.read(&path).is_empty());
        append(&path, tail);
        assert_eq!(reader.read(&path), [hook(HookEvent::NeedsInput, 3)]);
    }

    #[test]
    fn reader_skips_junk_and_long_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut reader = HookReader::default();
        let long = format!(
            "{{\"v\":1,\"event\":\"prompt\",\"at\":1,\"x\":\"{}\"}}\n",
            "a".repeat(5000)
        );
        append(&path, "nope\n");
        append(&path, &long);
        append(&path, &line("prompt", 9).replace("\"v\":1", "\"v\":2"));
        append(&path, &line("turn-done", 4));
        assert_eq!(reader.read(&path), [hook(HookEvent::TurnDone, 4)]);
    }

    #[test]
    fn reader_passes_a_valid_session_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut reader = HookReader::default();
        append(
            &path,
            "{\"v\":1,\"event\":\"turn-done\",\"at\":3,\"session\":\"s-1\"}\n",
        );
        append(
            &path,
            "{\"v\":1,\"event\":\"turn-done\",\"at\":4,\"session\":\"a/b\"}\n",
        );
        append(&path, &line("turn-done", 5));
        let with = PtyHook {
            session: Some("s-1".into()),
            ..hook(HookEvent::TurnDone, 3)
        };
        assert_eq!(
            reader.read(&path),
            [
                with,
                hook(HookEvent::TurnDone, 4),
                hook(HookEvent::TurnDone, 5)
            ]
        );
    }

    #[test]
    fn reader_skips_a_long_line_still_being_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut reader = HookReader::default();
        append(&path, &"x".repeat(MAX_LINE + 10));
        assert!(reader.read(&path).is_empty());
        append(&path, &("y".repeat(20) + "\n" + &line("prompt", 5)));
        assert_eq!(reader.read(&path), [hook(HookEvent::Prompt, 5)]);
    }

    #[test]
    fn reader_restarts_after_truncate() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut reader = HookReader::default();
        append(&path, &(line("prompt", 1) + &line("turn-done", 2)));
        assert_eq!(reader.read(&path).len(), 2);
        fs::write(&path, line("needs-input", 3)).unwrap();
        assert_eq!(reader.read(&path), [hook(HookEvent::NeedsInput, 3)]);
    }

    #[test]
    fn existing_lines_are_not_replayed() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        append(
            &path,
            &(line("prompt", 1) + &line("turn-done", 2) + &line("prompt", 3)),
        );
        let mut reader = HookReader::default();
        reader.prime(dir.path());
        assert!(reader.read(&path).is_empty());
        append(&path, &line("turn-done", 4));
        assert_eq!(reader.read(&path), [hook(HookEvent::TurnDone, 4)]);
    }

    #[test]
    fn file_with_bad_stem_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("hooks");
        fs::create_dir(&inner).unwrap();
        let mut reader = HookReader::default();
        for name in [
            "abc.jsonl",
            &format!("{ID}.txt"),
            &format!("{}.jsonl", ID.to_uppercase()),
        ] {
            let path = inner.join(name);
            append(&path, &line("prompt", 1));
            assert!(reader.read(&path).is_empty(), "{name}");
        }
        let outside = dir.path().join("x.jsonl");
        append(&outside, &line("prompt", 1));
        assert!(reader.read(&inner.join("..").join("x.jsonl")).is_empty());
    }

    #[test]
    fn offsets_follow_the_pane_not_the_path_spelling() {
        // macOS reports `/private/var/...` for a temp dir primed as
        // `/var/...`; another spelling of the same file must not replay it.
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join("hooks");
        fs::create_dir(&hooks).unwrap();
        append(&file(&hooks), &line("prompt", 1));
        let mut reader = HookReader::default();
        reader.prime(&hooks);
        let alias = hooks.join("..").join("hooks").join(format!("{ID}.jsonl"));
        assert!(reader.read(&alias).is_empty());
        append(&file(&hooks), &line("turn-done", 2));
        assert_eq!(reader.read(&alias), [hook(HookEvent::TurnDone, 2)]);
    }

    #[test]
    fn watcher_emits_appended_lines() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join("hooks");
        fs::create_dir(&hooks).unwrap();
        append(&file(&hooks), &line("prompt", 1));
        let (tx, rx) = mpsc::channel();
        let _watcher = start(hooks.clone(), move |hook| {
            let _ = tx.send(hook);
        })
        .unwrap();
        xdev_agent::append_hook_detail(dir.path(), ID, HookEvent::TurnDone, 7, None, Some("s-7"))
            .unwrap();
        let got = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let want = PtyHook {
            session: Some("s-7".into()),
            ..hook(HookEvent::TurnDone, 7)
        };
        assert_eq!(got, want);
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
    }
}
