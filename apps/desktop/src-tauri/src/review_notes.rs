//! Review notes: one JSON file per worktree under `<data>/review-notes/`,
//! read and replaced whole under `ReviewNotesLock`. A note never leaves the
//! machine except through the agent tab the person picks.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::State;
use xdev_workspace::{Registry, WorkspaceError, path_key};

use crate::accounts::data_dir;
use crate::atomic::write_atomic;
use crate::commands::{AppState, CmdError};

const DIR: &str = "review-notes";
const VERSION: u32 = 1;
const MAX_NOTES: usize = 500;
const MAX_BODY: usize = 20_000;
const MAX_ANCHOR: usize = 4_000;

#[derive(Default)]
pub struct ReviewNotesLock(Mutex<()>);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
    pub id: String,
    /// Relative path in the worktree, `/` separated.
    pub file: String,
    /// 1-based, on the new side.
    pub start_line: u32,
    pub line: u32,
    /// The text of those lines when the note was made.
    pub anchor: String,
    /// Markdown.
    pub body: String,
    /// Milliseconds since the epoch.
    pub created_at: f64,
    pub sent_at: Option<f64>,
    pub outdated: bool,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    path: String,
    notes: Vec<ReviewNote>,
}

fn bad_note(why: impl Into<String>) -> CmdError {
    CmdError {
        code: "bad_note",
        detail: Some(why.into()),
    }
}

fn io_err(detail: impl ToString) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(detail.to_string()),
    }
}

/// FNV-1a, 64 bit.
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn file_name(path: &Path) -> String {
    format!("{:016x}.json", fnv1a(&path_key(path)))
}

/// Only checkouts the registry knows.
fn known(data: &Path, path: &Path) -> Result<(), CmdError> {
    let key = path_key(path);
    let reg = Registry::load(data)?;
    let found = reg.worktrees.iter().any(|m| path_key(&m.path) == key)
        || reg.repos.iter().any(|r| path_key(&r.path) == key);
    if found {
        Ok(())
    } else {
        Err(WorkspaceError::WorktreeUnknown(path.to_owned()).into())
    }
}

enum Read {
    Missing,
    Ok(Vec<ReviewNote>),
    /// Another worktree's file (hash clash): empty, never overwritten.
    Clash,
    Broken,
    /// Could not read it (not "missing"): never treated as empty, so a put cannot wipe it.
    Failed(String),
}

fn read_file(file: &Path, path: &Path) -> Read {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Read::Missing,
        Err(e) => return Read::Failed(e.to_string()),
    };
    match serde_json::from_str::<Stored>(&text) {
        Ok(s) if s.path == path_key(path) => Read::Ok(s.notes),
        Ok(_) => Read::Clash,
        Err(_) => Read::Broken,
    }
}

fn plain_file(file: &str) -> bool {
    !file.is_empty()
        && !file.starts_with('/')
        && file
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
        && windows_safe(file)
}

/// Backslash and colon are path syntax only on Windows; elsewhere they are ordinary name characters.
#[cfg(windows)]
fn windows_safe(file: &str) -> bool {
    !file.contains('\\') && !file.contains(':')
}

#[cfg(not(windows))]
fn windows_safe(_file: &str) -> bool {
    true
}

fn validate(notes: &[ReviewNote]) -> Result<(), CmdError> {
    if notes.len() > MAX_NOTES {
        return Err(bad_note("too many notes"));
    }
    for (i, n) in notes.iter().enumerate() {
        let ok_id = (1..=64).contains(&n.id.len())
            && n.id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !ok_id {
            return Err(bad_note(format!("bad id {:?}", n.id)));
        }
        if notes[..i].iter().any(|o| o.id == n.id) {
            return Err(bad_note(format!("duplicate id {}", n.id)));
        }
        if n.start_line < 1 || n.start_line > n.line {
            return Err(bad_note(format!("bad lines in {}", n.id)));
        }
        if !plain_file(&n.file) {
            return Err(bad_note(format!("bad file in {}", n.id)));
        }
        if n.body.trim().is_empty() || n.body.chars().count() > MAX_BODY {
            return Err(bad_note(format!("bad body in {}", n.id)));
        }
        if n.anchor.chars().count() > MAX_ANCHOR {
            return Err(bad_note(format!("anchor too long in {}", n.id)));
        }
        if !n.created_at.is_finite() || n.sent_at.is_some_and(|t| !t.is_finite()) {
            return Err(bad_note(format!("bad time in {}", n.id)));
        }
    }
    Ok(())
}

fn get(data: &Path, lock: &ReviewNotesLock, path: &Path) -> Result<Vec<ReviewNote>, CmdError> {
    known(data, path)?;
    let _guard = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    let file = data.join(DIR).join(file_name(path));
    match read_file(&file, path) {
        Read::Ok(notes) => Ok(notes),
        Read::Failed(why) => Err(io_err(why)),
        Read::Missing | Read::Clash | Read::Broken => Ok(Vec::new()),
    }
}

fn put(
    data: &Path,
    lock: &ReviewNotesLock,
    path: &Path,
    notes: Vec<ReviewNote>,
) -> Result<Vec<ReviewNote>, CmdError> {
    known(data, path)?;
    validate(&notes)?;
    let _guard = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    let dir: PathBuf = data.join(DIR);
    let name = file_name(path);
    let file = dir.join(&name);
    match read_file(&file, path) {
        Read::Clash => return Err(io_err("notes file belongs to another worktree")),
        Read::Broken => {
            // Keep what was there; a later person can still read it.
            let _ = fs::rename(&file, dir.join(format!("{name}.bad")));
        }
        Read::Failed(why) => return Err(io_err(why)),
        Read::Ok(_) | Read::Missing => {}
    }
    let stored = Stored {
        version: VERSION,
        path: path_key(path),
        notes,
    };
    let text = serde_json::to_string_pretty(&stored).map_err(io_err)?;
    write_atomic(&file, text.as_bytes()).map_err(io_err)?;
    Ok(stored.notes)
}

#[tauri::command(async)]
pub fn review_notes_get(
    state: State<'_, AppState>,
    lock: State<'_, ReviewNotesLock>,
    path: PathBuf,
) -> Result<Vec<ReviewNote>, CmdError> {
    get(data_dir(&state)?, &lock, &path)
}

#[tauri::command(async)]
pub fn review_notes_put(
    state: State<'_, AppState>,
    lock: State<'_, ReviewNotesLock>,
    path: PathBuf,
    notes: Vec<ReviewNote>,
) -> Result<Vec<ReviewNote>, CmdError> {
    put(data_dir(&state)?, &lock, &path, notes)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{add_repo, create_worktree};

    use super::*;

    struct Fixture {
        _tmp: TempDir,
        data: PathBuf,
        wt: PathBuf,
        lock: ReviewNotesLock,
    }

    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("notes ");
        let main = tmp.path().join("main");
        let data = tmp.path().join("data");
        fs::create_dir(&main).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&main)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}: {out:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        for (k, v) in [
            ("user.name", "T"),
            ("user.email", "t@example.com"),
            ("commit.gpgsign", "false"),
        ] {
            git(&["config", k, v]);
        }
        fs::write(main.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        let mut reg = Registry::load(&data).unwrap();
        let id = add_repo(&mut reg, &main, 0).unwrap().id;
        let wt = create_worktree(&mut reg, &id, "first", None, 1, 1).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            data,
            wt: PathBuf::from(wt.path),
            lock: ReviewNotesLock::default(),
        }
    }

    fn note(id: &str) -> ReviewNote {
        ReviewNote {
            id: id.to_owned(),
            file: "src/a.ts".into(),
            start_line: 2,
            line: 3,
            anchor: "x\ny".into(),
            body: "fix **this**".into(),
            created_at: 1000.0,
            sent_at: None,
            outdated: false,
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn empty_when_no_file() {
        let fx = fixture();
        assert!(get(&fx.data, &fx.lock, &fx.wt).unwrap().is_empty());
    }

    #[test]
    fn put_then_get_round_trip() {
        let fx = fixture();
        let notes = vec![note("a"), note("b")];
        let stored = put(&fx.data, &fx.lock, &fx.wt, notes.clone()).unwrap();
        assert_eq!(stored, notes);
        assert_eq!(get(&fx.data, &fx.lock, &fx.wt).unwrap(), notes);
    }

    #[test]
    fn file_name_is_hash_of_path_key() {
        let a = file_name(Path::new("C:\\X"));
        let b = file_name(Path::new("c:/x"));
        if cfg!(windows) {
            assert_eq!(a, b);
        }
        assert_eq!(a.len(), 16 + ".json".len());
        assert!(a[..16].bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn clash_reads_empty_and_is_not_overwritten() {
        let fx = fixture();
        let dir = fx.data.join(DIR);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(file_name(&fx.wt));
        let other = Stored {
            version: VERSION,
            path: "elsewhere".into(),
            notes: vec![note("keep")],
        };
        let text = serde_json::to_string(&other).unwrap();
        fs::write(&file, &text).unwrap();
        assert!(get(&fx.data, &fx.lock, &fx.wt).unwrap().is_empty());
        assert!(put(&fx.data, &fx.lock, &fx.wt, vec![note("a")]).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), text);
    }

    #[test]
    fn unreadable_file_is_an_error_not_empty() {
        let fx = fixture();
        let dir = fx.data.join(DIR);
        // A directory where the file should be: reading it fails, but not with NotFound.
        fs::create_dir_all(dir.join(file_name(&fx.wt))).unwrap();
        assert_eq!(code(get(&fx.data, &fx.lock, &fx.wt)), "io");
        assert_eq!(code(put(&fx.data, &fx.lock, &fx.wt, vec![note("a")])), "io");
    }

    #[test]
    fn broken_file_is_kept_aside() {
        let fx = fixture();
        let dir = fx.data.join(DIR);
        fs::create_dir_all(&dir).unwrap();
        let name = file_name(&fx.wt);
        fs::write(dir.join(&name), "{ not json").unwrap();
        assert!(get(&fx.data, &fx.lock, &fx.wt).unwrap().is_empty());
        put(&fx.data, &fx.lock, &fx.wt, vec![note("a")]).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(format!("{name}.bad"))).unwrap(),
            "{ not json"
        );
        assert_eq!(get(&fx.data, &fx.lock, &fx.wt).unwrap().len(), 1);
    }

    #[test]
    fn bad_note_refuses_whole_put() {
        let fx = fixture();
        let good = vec![note("a")];
        put(&fx.data, &fx.lock, &fx.wt, good.clone()).unwrap();
        let mut empty = note("b");
        empty.body = "  \n".into();
        let mut range = note("c");
        range.start_line = 5;
        let mut dots = note("d");
        dots.file = "../x".into();
        let mut abs = note("e");
        abs.file = "/etc/x".into();
        let mut zero = note("f");
        zero.start_line = 0;
        let mut id = note("g");
        id.id = "bad id".into();
        for bad in [empty, range, dots, abs, zero, id] {
            let r = put(&fx.data, &fx.lock, &fx.wt, vec![note("a"), bad]);
            assert_eq!(code(r), "bad_note");
        }
        let dup = put(&fx.data, &fx.lock, &fx.wt, vec![note("a"), note("a")]);
        assert_eq!(code(dup), "bad_note");
        let many: Vec<_> = (0..=MAX_NOTES).map(|i| note(&format!("n{i}"))).collect();
        assert_eq!(code(put(&fx.data, &fx.lock, &fx.wt, many)), "bad_note");
        assert_eq!(get(&fx.data, &fx.lock, &fx.wt).unwrap(), good);
    }

    #[test]
    fn unknown_worktree_refused() {
        let fx = fixture();
        let other = fx._tmp.path().join("other");
        fs::create_dir(&other).unwrap();
        assert_eq!(code(get(&fx.data, &fx.lock, &other)), "worktree_unknown");
        assert_eq!(
            code(put(&fx.data, &fx.lock, &other, vec![])),
            "worktree_unknown"
        );
    }

    #[test]
    fn write_is_atomic() {
        let fx = fixture();
        put(&fx.data, &fx.lock, &fx.wt, vec![note("a")]).unwrap();
        let names: Vec<String> = fs::read_dir(fx.data.join(DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(!names[0].ends_with(".tmp"));
    }
}
