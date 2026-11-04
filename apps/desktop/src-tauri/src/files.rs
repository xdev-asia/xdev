//! File tabs and the file tree's menu: thin commands over
//! `xdev_workspace::files`. Each one first checks that `worktree` is a repo
//! or worktree the registry knows; the crate keeps every `rel` inside it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::State;
use tauri::ipc::Channel;
use xdev_policy::Action;
use xdev_workspace::{
    Eol, FileList, FileText, OsTrash, SearchEvent, SearchQuery, Trash, WriteOutcome, create_entry,
    entry_path, list_files, read_file, rename_entry, search_text, trash_entry_with, write_file,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{allowed, known_checkout};

/// `worktree` as the crate takes it, once the registry knows it.
fn root(data: &Path, worktree: &Path) -> Result<String, CmdError> {
    known_checkout(data, worktree)?;
    Ok(worktree.to_string_lossy().into_owned())
}

fn read(data: &Path, worktree: &Path, rel: &str) -> Result<FileText, CmdError> {
    Ok(read_file(&root(data, worktree)?, rel)?)
}

fn write(
    data: &Path,
    worktree: &Path,
    rel: &str,
    text: &str,
    eol: Eol,
    expected: Option<&str>,
) -> Result<WriteOutcome, CmdError> {
    Ok(write_file(
        &root(data, worktree)?,
        rel,
        text,
        eol,
        expected,
    )?)
}

fn create(data: &Path, worktree: &Path, rel: &str, dir: bool) -> Result<(), CmdError> {
    Ok(create_entry(&root(data, worktree)?, rel, dir)?)
}

fn rename(data: &Path, worktree: &Path, from: &str, to: &str) -> Result<(), CmdError> {
    Ok(rename_entry(&root(data, worktree)?, from, to)?)
}

/// The UI's delete dialog is the user's yes, so the gate is asked as
/// confirmed: `Ask` lets it through, `Deny` still keeps the item.
fn trash_with(data: &Path, worktree: &Path, rel: &str, bin: &dyn Trash) -> Result<(), CmdError> {
    let root = root(data, worktree)?;
    let path = entry_path(&root, rel)?;
    allowed(data, &Action::Delete { path }, true)?;
    Ok(trash_entry_with(&root, rel, bin)?)
}

fn reveal_path(data: &Path, worktree: &Path, rel: &str) -> Result<PathBuf, CmdError> {
    Ok(entry_path(&root(data, worktree)?, rel)?)
}

/// The file's text, or why it has none (binary, too large).
#[tauri::command(async)]
pub fn file_read(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<FileText, CmdError> {
    read(data_dir(&state)?, &worktree, &rel)
}

/// Saves `text` with `eol` when the file still has the `expected` hash
/// (`None`: the file must not exist); `Conflict` otherwise.
#[tauri::command(async)]
pub fn file_write(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
    text: String,
    eol: Eol,
    expected: Option<String>,
) -> Result<WriteOutcome, CmdError> {
    write(
        data_dir(&state)?,
        &worktree,
        &rel,
        &text,
        eol,
        expected.as_deref(),
    )
}

#[tauri::command(async)]
pub fn file_create(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
    dir: bool,
) -> Result<(), CmdError> {
    create(data_dir(&state)?, &worktree, &rel, dir)
}

#[tauri::command(async)]
pub fn file_rename(
    state: State<'_, AppState>,
    worktree: PathBuf,
    from: String,
    to: String,
) -> Result<(), CmdError> {
    rename(data_dir(&state)?, &worktree, &from, &to)
}

/// Asks the policy gate (`Delete`) first, then moves the item to the trash.
#[tauri::command(async)]
pub fn file_trash(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<(), CmdError> {
    trash_with(data_dir(&state)?, &worktree, &rel, &OsTrash)
}

/// Opens the OS file manager with the item selected where the OS allows it.
#[tauri::command(async)]
pub fn file_reveal(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<(), CmdError> {
    let path = reveal_path(data_dir(&state)?, &worktree, &rel)?;
    Ok(crate::reveal::reveal(&path, true)?)
}

// Quick open and search in files.

/// The searches running now, by the id the UI gave each.
#[derive(Default)]
pub struct Searches {
    _runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Every file of the worktree `.gitignore` keeps, for quick open.
#[tauri::command(async)]
pub fn files_list(state: State<'_, AppState>, worktree: PathBuf) -> Result<FileList, CmdError> {
    Ok(list_files(&root(data_dir(&state)?, &worktree)?)?)
}

/// Searches the worktree's files, sending `SearchEvent`s on `on_event`. A new
/// search with the same `id` cancels the old one.
#[tauri::command(async)]
pub fn files_search(
    state: State<'_, AppState>,
    _searches: State<'_, Searches>,
    worktree: PathBuf,
    query: SearchQuery,
    id: String,
    on_event: Channel<SearchEvent>,
) -> Result<(), CmdError> {
    let _ = id;
    let root = root(data_dir(&state)?, &worktree)?;
    let cancel = AtomicBool::new(false);
    Ok(search_text(&root, &query, &cancel, &mut |event| {
        // The window may be gone; nobody is listening then.
        let _ = on_event.send(event);
    })?)
}

/// Stops the search named `id`; nothing when it is not running.
#[tauri::command]
pub fn files_search_cancel(_searches: State<'_, Searches>, id: String) -> Result<(), CmdError> {
    let _ = id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::io;
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_policy::Verdict;
    use xdev_workspace::{Registry, add_repo};

    use super::*;

    /// A repo with one commit, tracked by the registry in `data`.
    struct Fixture {
        _tmp: TempDir,
        repo: PathBuf,
        data: PathBuf,
        stranger: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("files cmd ");
        let repo = tmp.path().join("repo");
        let data = tmp.path().join("data");
        let stranger = tmp.path().join("stranger");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&stranger).unwrap();
        fs::write(stranger.join("a.txt"), "theirs").unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&repo)
                .args(args)
                .output()
                .expect("run git");
            assert!(out.status.success(), "git {args:?}: {out:?}");
        };
        git(&["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&["config", key, value]);
        }
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        let mut reg = Registry::load(&data).unwrap();
        add_repo(&mut reg, &repo, 0).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            repo,
            data,
            stranger,
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    /// Records what it was handed and keeps it where it is.
    #[derive(Default)]
    struct FakeTrash {
        taken: RefCell<Vec<PathBuf>>,
    }

    impl Trash for FakeTrash {
        fn trash(&self, path: &Path) -> io::Result<()> {
            self.taken.borrow_mut().push(path.to_owned());
            Ok(())
        }
    }

    #[test]
    fn every_command_refuses_a_worktree_the_registry_does_not_know() {
        let fx = fixture();
        let (data, wt) = (&fx.data, &fx.stranger);
        let bin = FakeTrash::default();
        assert_eq!(code(read(data, wt, "a.txt")), "worktree_unknown");
        assert_eq!(
            code(write(data, wt, "a.txt", "x", Eol::Lf, None)),
            "worktree_unknown"
        );
        assert_eq!(code(create(data, wt, "b.txt", false)), "worktree_unknown");
        assert_eq!(code(rename(data, wt, "a.txt", "b.txt")), "worktree_unknown");
        assert_eq!(
            code(trash_with(data, wt, "a.txt", &bin)),
            "worktree_unknown"
        );
        assert_eq!(code(reveal_path(data, wt, "a.txt")), "worktree_unknown");
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "theirs");
        assert!(!wt.join("b.txt").exists());
        assert!(bin.taken.borrow().is_empty());
    }

    #[test]
    fn commands_work_on_a_known_checkout_and_keep_paths_inside() {
        let fx = fixture();
        let (data, wt) = (&fx.data, &fx.repo);
        let file = read(data, wt, "a.txt").unwrap();
        assert_eq!(file.text.as_deref(), Some("one\n"));
        let saved = write(data, wt, "a.txt", "two\n", Eol::Lf, Some(&file.hash)).unwrap();
        assert!(matches!(saved, WriteOutcome::Saved { .. }));
        create(data, wt, "notes", true).unwrap();
        rename(data, wt, "a.txt", "notes/a.txt").unwrap();
        assert_eq!(
            fs::read_to_string(wt.join("notes").join("a.txt")).unwrap(),
            "two\n"
        );
        assert_eq!(
            reveal_path(data, wt, "notes/a.txt").unwrap(),
            wt.join("notes").join("a.txt")
        );
        for rel in ["../stranger/a.txt", ".git/config", ""] {
            assert_eq!(code(read(data, wt, rel)), "bad_path", "{rel}");
            assert_eq!(code(reveal_path(data, wt, rel)), "bad_path", "{rel}");
        }
        assert_eq!(code(reveal_path(data, wt, "gone.txt")), "not_found");
    }

    #[test]
    fn trash_asks_the_gate_as_confirmed() {
        let fx = fixture();
        let bin = FakeTrash::default();
        trash_with(&fx.data, &fx.repo, "a.txt", &bin).unwrap();
        assert_eq!(*bin.taken.borrow(), [fx.repo.join("a.txt")]);
        let audit = xdev_policy::read_audit(&fx.data).unwrap();
        assert!(matches!(audit[..], [ref entry] if entry.verdict == Verdict::Allow));
    }

    #[test]
    fn trash_denied_by_policy_keeps_the_file() {
        let fx = fixture();
        fs::write(fx.data.join("policy.json"), r#"{"delete":"deny"}"#).unwrap();
        let bin = FakeTrash::default();
        let err = trash_with(&fx.data, &fx.repo, "a.txt", &bin).unwrap_err();
        assert_eq!(err.code, "denied");
        assert!(bin.taken.borrow().is_empty());
        assert!(fx.repo.join("a.txt").is_file());
        // A missing item is reported before the gate is asked.
        assert_eq!(
            code(trash_with(&fx.data, &fx.repo, "gone.txt", &bin)),
            "not_found"
        );
    }
}
