//! File tabs and the file tree's menu: thin commands over
//! `xdev_workspace::files`. Each one first checks that `worktree` is a repo
//! or worktree the registry knows; the crate keeps every `rel` inside it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use xdev_policy::Action;
use xdev_workspace::{
    Eol, FileList, FileText, OsTrash, SearchEvent, SearchQuery, Trash, WriteOutcome, create_entry,
    entry_path, list_files, media_kind, read_bytes, read_file, rename_entry, search_text,
    trash_entry_with, write_file,
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

/// The raw bytes of an image, audio or video file within its size cap.
#[tauri::command(async)]
pub fn file_bytes(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<Response, CmdError> {
    let bytes = read_bytes(&root(data_dir(&state)?, &worktree)?, &rel)?;
    Ok(Response::new(InvokeResponseBody::Raw(bytes)))
}

/// The path to open in the default app: only image, audio and video files,
/// so an executable is never launched.
fn open_default_path(data: &Path, worktree: &Path, rel: &str) -> Result<PathBuf, CmdError> {
    let root = root(data, worktree)?;
    if media_kind(rel).is_none() {
        return Err(xdev_workspace::WorkspaceError::BadName(rel.to_owned()).into());
    }
    Ok(entry_path(&root, rel)?)
}

/// Opens an image, audio or video file in the OS default app.
#[tauri::command(async)]
pub fn file_open_default(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<(), CmdError> {
    let path = open_default_path(data_dir(&state)?, &worktree, &rel)?;
    Ok(crate::reveal::reveal(&path, false)?)
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

/// The searches running now, by the id the UI gave each, with the flag that
/// stops each one. Clones share the map.
#[derive(Default, Clone)]
pub struct Searches {
    runs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Searches {
    fn runs(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.runs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new run under `id`; the one there before is told to stop.
    fn start(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(old) = self.runs().insert(id.to_owned(), Arc::clone(&flag)) {
            old.store(true, Ordering::SeqCst);
        }
        flag
    }

    /// Forgets the run `flag` under `id`, unless a newer run took the id.
    fn finish(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut runs = self.runs();
        if runs.get(id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            runs.remove(id);
        }
    }

    fn cancel(&self, id: &str) {
        if let Some(flag) = self.runs().remove(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    #[cfg(test)]
    fn running(&self) -> Vec<String> {
        self.runs().keys().cloned().collect()
    }
}

fn list(data: &Path, worktree: &Path) -> Result<FileList, CmdError> {
    Ok(list_files(&root(data, worktree)?)?)
}

/// Runs `query` under `id`, cancelling the run that had the id. Once
/// cancelled, by `cancel` or a newer run, `send` hears nothing more.
fn search(
    searches: &Searches,
    data: &Path,
    worktree: &Path,
    query: &SearchQuery,
    id: &str,
    send: &mut dyn FnMut(SearchEvent),
) -> Result<(), CmdError> {
    let root = root(data, worktree)?;
    let flag = searches.start(id);
    let out = search_text(&root, query, &flag, &mut |event| {
        if !flag.load(Ordering::SeqCst) {
            send(event);
        }
    });
    searches.finish(id, &flag);
    Ok(out?)
}

/// Every file of the worktree `.gitignore` keeps, for quick open.
#[tauri::command(async)]
pub fn files_list(state: State<'_, AppState>, worktree: PathBuf) -> Result<FileList, CmdError> {
    list(data_dir(&state)?, &worktree)
}

/// Searches the worktree's files on a blocking thread, sending `SearchEvent`s
/// on `on_event`. A new search with the same `id` cancels the old one.
#[tauri::command]
pub async fn files_search(
    state: State<'_, AppState>,
    searches: State<'_, Searches>,
    worktree: PathBuf,
    query: SearchQuery,
    id: String,
    on_event: Channel<SearchEvent>,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?.to_path_buf();
    let searches = Searches::clone(&searches);
    tauri::async_runtime::spawn_blocking(move || {
        search(&searches, &data, &worktree, &query, &id, &mut |event| {
            // The window may be gone; nobody is listening then.
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?
}

/// Stops the search named `id`; nothing when it is not running.
#[tauri::command]
pub fn files_search_cancel(searches: State<'_, Searches>, id: String) -> Result<(), CmdError> {
    searches.cancel(&id);
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
    fn open_default_allows_only_media_files() {
        let fx = fixture();
        fs::write(fx.repo.join("pic.PNG"), [1u8]).unwrap();
        let path = open_default_path(&fx.data, &fx.repo, "pic.PNG").unwrap();
        assert!(path.ends_with("pic.PNG"));
        for rel in ["run.exe", "run.sh", "a.txt", "setup.bat", "noext"] {
            assert_eq!(
                code(open_default_path(&fx.data, &fx.repo, rel)),
                "bad_name",
                "{rel}"
            );
        }
        assert_eq!(
            code(open_default_path(&fx.data, &fx.repo, "../x.png")),
            "bad_path"
        );
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
        assert_eq!(
            code(open_default_path(data, wt, "a.png")),
            "worktree_unknown"
        );
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

    fn needle_query() -> SearchQuery {
        SearchQuery {
            text: "needle".into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            include: vec![],
            exclude: vec![],
        }
    }

    #[test]
    fn search_commands_refuse_a_worktree_the_registry_does_not_know() {
        let fx = fixture();
        fs::write(fx.stranger.join("n.txt"), "needle\n").unwrap();
        let searches = Searches::default();
        assert_eq!(code(list(&fx.data, &fx.stranger)), "worktree_unknown");
        let mut seen = Vec::new();
        let r = search(
            &searches,
            &fx.data,
            &fx.stranger,
            &needle_query(),
            "s",
            &mut |e| seen.push(e),
        );
        assert_eq!(code(r), "worktree_unknown");
        assert!(seen.is_empty());
        assert!(searches.running().is_empty());
    }

    #[test]
    fn a_known_worktree_is_listed_and_searched() {
        let fx = fixture();
        fs::write(fx.repo.join("n.txt"), "a needle\n").unwrap();
        assert_eq!(
            list(&fx.data, &fx.repo).unwrap().files,
            vec!["a.txt".to_owned(), "n.txt".to_owned()]
        );
        let searches = Searches::default();
        let mut seen = Vec::new();
        search(
            &searches,
            &fx.data,
            &fx.repo,
            &needle_query(),
            "s",
            &mut |e| seen.push(e),
        )
        .unwrap();
        assert!(
            matches!(&seen[..], [SearchEvent::Batch { files }, SearchEvent::Done { hits: 1, .. }] if files[0].rel == "n.txt")
        );
        // A finished search leaves nothing behind.
        assert!(searches.running().is_empty());
    }

    /// Enough matching files for more than one batch.
    fn many_hits(fx: &Fixture) {
        for i in 0..120 {
            fs::write(fx.repo.join(format!("f{i:03}.txt")), "needle\n").unwrap();
        }
    }

    #[test]
    fn a_second_search_with_the_same_id_silences_the_first() {
        let fx = fixture();
        many_hits(&fx);
        let searches = Searches::default();
        let mut first = Vec::new();
        let mut second = Vec::new();
        let mut after_second = 0;
        search(
            &searches,
            &fx.data,
            &fx.repo,
            &needle_query(),
            "panel",
            &mut |e| {
                if first.is_empty() {
                    first.push(e);
                    // The panel starts a new search while the first runs.
                    search(
                        &searches,
                        &fx.data,
                        &fx.repo,
                        &needle_query(),
                        "panel",
                        &mut |e| second.push(e),
                    )
                    .unwrap();
                } else {
                    after_second += 1;
                }
            },
        )
        .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(
            after_second, 0,
            "the first search spoke after the second started"
        );
        assert!(matches!(
            second.last(),
            Some(SearchEvent::Done { hits: 120, .. })
        ));
        assert!(searches.running().is_empty());
    }

    #[test]
    fn cancel_stops_a_running_search_and_ignores_unknown_ids() {
        let fx = fixture();
        many_hits(&fx);
        let searches = Searches::default();
        searches.cancel("nobody");
        let mut seen = Vec::new();
        search(
            &searches,
            &fx.data,
            &fx.repo,
            &needle_query(),
            "panel",
            &mut |e| {
                seen.push(e);
                searches.cancel("panel");
            },
        )
        .unwrap();
        assert_eq!(seen.len(), 1);
        assert!(matches!(seen[0], SearchEvent::Batch { .. }));
        assert!(searches.running().is_empty());
    }

    #[test]
    fn searches_with_other_ids_run_side_by_side() {
        let searches = Searches::default();
        let a = searches.start("a");
        let b = searches.start("b");
        let mut ids = searches.running();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
        // An old run ending does not drop the newer one under its id.
        let a2 = searches.start("a");
        assert!(a.load(Ordering::SeqCst));
        searches.finish("a", &a);
        assert_eq!(searches.running().len(), 2);
        searches.finish("a", &a2);
        searches.finish("b", &b);
        assert!(!b.load(Ordering::SeqCst));
        assert!(searches.running().is_empty());
    }
}
