//! Sticky notes: one Markdown note per terminal tab, kept in `<data>/notes.json`,
//! read and replaced whole under `NotesLock`. A note never leaves the machine
//! except through the tab the person sends it to.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::accounts::data_dir;
use crate::atomic::write_atomic;
use crate::commands::{AppState, CmdError};

const FILE: &str = "notes.json";
const VERSION: u32 = 1;
/// The most bytes one note body holds.
pub const BODY_MAX: usize = 64 * 1024;
/// The most notes kept; a put past it fails, a delete frees room.
const NOTES_MAX: usize = 2_000;
const TAB_MAX: usize = 128;
const LABEL_MAX: usize = 400;

#[derive(Default)]
pub struct NotesLock(Mutex<()>);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// The tab the note belongs to.
    pub tab: String,
    /// The worktree the tab was in when the note was saved.
    pub worktree: String,
    /// The tab's name when the note was saved.
    pub title: String,
    /// Markdown, at most 64 KB.
    pub body: String,
    /// Milliseconds since the epoch.
    pub updated_at: f64,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    notes: Vec<Note>,
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

fn read_all(file: &Path) -> Result<Vec<Note>, CmdError> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err(e)),
    };
    // A broken file reads as no notes; a put keeps it aside first.
    Ok(serde_json::from_str::<Stored>(&text).map_or_else(|_| Vec::new(), |s| s.notes))
}

fn write_all(file: &Path, notes: &[Note]) -> Result<(), CmdError> {
    if let Ok(text) = fs::read_to_string(file)
        && serde_json::from_str::<Stored>(&text).is_err()
    {
        let _ = fs::rename(file, file.with_extension("json.bad"));
    }
    let text = serde_json::to_string_pretty(&Stored {
        version: VERSION,
        notes: notes.to_vec(),
    })
    .map_err(io_err)?;
    write_atomic(file, text.as_bytes()).map_err(io_err)
}

fn plain(text: &str, max: usize) -> bool {
    text.chars().count() <= max && !text.chars().any(char::is_control)
}

fn list(data: &Path, lock: &NotesLock) -> Result<Vec<Note>, CmdError> {
    let _guard = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    let mut notes = read_all(&data.join(FILE))?;
    notes.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
    Ok(notes)
}

fn get(data: &Path, lock: &NotesLock, tab: &str) -> Result<Option<Note>, CmdError> {
    Ok(list(data, lock)?.into_iter().find(|n| n.tab == tab))
}

/// Saves the note of `tab`. A blank body removes it (and returns `None`).
fn put(data: &Path, lock: &NotesLock, note: Note, now: f64) -> Result<Option<Note>, CmdError> {
    if note.tab.is_empty() || !plain(&note.tab, TAB_MAX) {
        return Err(bad_note("bad tab"));
    }
    if !plain(&note.worktree, 4_096) || !plain(&note.title, LABEL_MAX) {
        return Err(bad_note("bad label"));
    }
    if note.body.len() > BODY_MAX {
        return Err(bad_note("note is longer than 64 KB"));
    }
    let _guard = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    let file = data.join(FILE);
    let mut notes = read_all(&file)?;
    let at = notes.iter().position(|n| n.tab == note.tab);
    if note.body.trim().is_empty() {
        if let Some(i) = at {
            notes.remove(i);
            write_all(&file, &notes)?;
        }
        return Ok(None);
    }
    if at.is_none() && notes.len() >= NOTES_MAX {
        return Err(bad_note("too many notes"));
    }
    let saved = Note {
        updated_at: now,
        ..note
    };
    match at {
        Some(i) => notes[i] = saved.clone(),
        None => notes.push(saved.clone()),
    }
    write_all(&file, &notes)?;
    Ok(Some(saved))
}

fn delete(data: &Path, lock: &NotesLock, tab: &str) -> Result<(), CmdError> {
    let _guard = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    let file = data.join(FILE);
    let mut notes = read_all(&file)?;
    let before = notes.len();
    notes.retain(|n| n.tab != tab);
    if notes.len() != before {
        write_all(&file, &notes)?;
    }
    Ok(())
}

fn now_ms_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// Every note, newest first.
#[tauri::command(async)]
pub fn notes_list(
    state: State<'_, AppState>,
    lock: State<'_, NotesLock>,
) -> Result<Vec<Note>, CmdError> {
    list(data_dir(&state)?, &lock)
}

#[tauri::command(async)]
pub fn notes_get(
    state: State<'_, AppState>,
    lock: State<'_, NotesLock>,
    tab: String,
) -> Result<Option<Note>, CmdError> {
    get(data_dir(&state)?, &lock, &tab)
}

/// Saves a note (the time is set here); a blank body removes the note.
#[tauri::command(async)]
pub fn notes_put(
    state: State<'_, AppState>,
    lock: State<'_, NotesLock>,
    note: Note,
) -> Result<Option<Note>, CmdError> {
    put(data_dir(&state)?, &lock, note, now_ms_f64())
}

#[tauri::command(async)]
pub fn notes_delete(
    state: State<'_, AppState>,
    lock: State<'_, NotesLock>,
    tab: String,
) -> Result<(), CmdError> {
    delete(data_dir(&state)?, &lock, &tab)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn note(tab: &str, body: &str) -> Note {
        Note {
            tab: tab.into(),
            worktree: "/w/one".into(),
            title: "Claude".into(),
            body: body.into(),
            updated_at: 0.0,
        }
    }

    fn fx() -> (TempDir, NotesLock) {
        (TempDir::new().unwrap(), NotesLock::default())
    }

    #[test]
    fn empty_without_a_file() {
        let (d, l) = fx();
        assert!(list(d.path(), &l).unwrap().is_empty());
        assert_eq!(get(d.path(), &l, "t1").unwrap(), None);
    }

    #[test]
    fn put_get_list_round_trip_and_replace() {
        let (d, l) = fx();
        let a = put(d.path(), &l, note("t1", "# one"), 10.0)
            .unwrap()
            .unwrap();
        assert_eq!(a.updated_at, 10.0);
        put(d.path(), &l, note("t2", "two"), 20.0).unwrap();
        put(d.path(), &l, note("t1", "one again"), 30.0).unwrap();
        assert_eq!(get(d.path(), &l, "t1").unwrap().unwrap().body, "one again");
        let all = list(d.path(), &l).unwrap();
        assert_eq!(
            all.iter().map(|n| n.tab.as_str()).collect::<Vec<_>>(),
            ["t1", "t2"]
        );
    }

    #[test]
    fn a_blank_body_removes_the_note() {
        let (d, l) = fx();
        put(d.path(), &l, note("t1", "x"), 1.0).unwrap();
        assert_eq!(put(d.path(), &l, note("t1", "  \n"), 2.0).unwrap(), None);
        assert!(list(d.path(), &l).unwrap().is_empty());
        // Blank for a tab with no note is a no-op.
        assert_eq!(put(d.path(), &l, note("t9", ""), 3.0).unwrap(), None);
    }

    #[test]
    fn delete_removes_only_that_tab() {
        let (d, l) = fx();
        put(d.path(), &l, note("t1", "x"), 1.0).unwrap();
        put(d.path(), &l, note("t2", "y"), 2.0).unwrap();
        delete(d.path(), &l, "t1").unwrap();
        delete(d.path(), &l, "nope").unwrap();
        let all = list(d.path(), &l).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].tab, "t2");
    }

    #[test]
    fn body_is_bounded_to_64_kb() {
        let (d, l) = fx();
        let ok = "a".repeat(BODY_MAX);
        assert!(put(d.path(), &l, note("t1", &ok), 1.0).unwrap().is_some());
        let big = "a".repeat(BODY_MAX + 1);
        assert_eq!(
            put(d.path(), &l, note("t1", &big), 2.0).unwrap_err().code,
            "bad_note"
        );
        // Bytes count, not characters.
        let wide = "é".repeat(BODY_MAX / 2 + 1);
        assert_eq!(
            put(d.path(), &l, note("t1", &wide), 3.0).unwrap_err().code,
            "bad_note"
        );
        assert_eq!(get(d.path(), &l, "t1").unwrap().unwrap().body, ok);
    }

    #[test]
    fn bad_tab_and_labels_are_refused() {
        let (d, l) = fx();
        assert_eq!(
            put(d.path(), &l, note("", "x"), 1.0).unwrap_err().code,
            "bad_note"
        );
        assert_eq!(
            put(d.path(), &l, note("a\nb", "x"), 1.0).unwrap_err().code,
            "bad_note"
        );
        let mut long = note("t", "x");
        long.title = "t".repeat(LABEL_MAX + 1);
        assert_eq!(put(d.path(), &l, long, 1.0).unwrap_err().code, "bad_note");
    }

    #[test]
    fn a_broken_file_reads_empty_and_is_kept_aside_on_put() {
        let (d, l) = fx();
        fs::write(d.path().join(FILE), "{ not json").unwrap();
        assert!(list(d.path(), &l).unwrap().is_empty());
        put(d.path(), &l, note("t1", "x"), 1.0).unwrap();
        assert!(d.path().join("notes.json.bad").exists());
        assert_eq!(list(d.path(), &l).unwrap().len(), 1);
    }
}
