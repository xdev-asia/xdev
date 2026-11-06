//! The pull request panel of a worktree: the PR of its branch in full, a
//! comment, auto-merge on or off, its title and body, its reviewers, and the
//! files the signed-in login marked viewed. Every command runs `gh`
//! as the login the repo is bound to, in the registered worktree.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::State;
use xdev_git::{
    GhExec, MergeMethod, PrDetail, PrViewed, SystemGh, pr_auto_merge_disable, pr_auto_merge_enable,
    pr_comment_add, pr_detail, pr_edit, pr_file_viewed, pr_reviewer_candidates, pr_reviewers_edit,
    pr_viewed_files,
};
use xdev_workspace::{Registry, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::ship::{gh_account_for, run_gh};

fn detail_with(gh: &dyn GhExec, path: &Path) -> Result<Option<PrDetail>, CmdError> {
    Ok(pr_detail(gh, path)?)
}

fn comment_with(gh: &dyn GhExec, path: &Path, number: u64, body: &str) -> Result<(), CmdError> {
    Ok(pr_comment_add(gh, path, number, body)?)
}

fn auto_with(
    gh: &dyn GhExec,
    path: &Path,
    number: u64,
    method: Option<MergeMethod>,
) -> Result<(), CmdError> {
    match method {
        Some(m) => pr_auto_merge_enable(gh, path, number, m)?,
        None => pr_auto_merge_disable(gh, path, number)?,
    }
    Ok(())
}

/// The reviewer candidates of each repo, read once per session.
static CANDIDATES: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

/// The repo a worktree belongs to, so its worktrees share one candidate list.
/// An unregistered path stands for itself.
fn repo_key(data: &Path, path: &Path) -> Result<String, CmdError> {
    let key = path_key(path);
    let reg = Registry::load(data)?;
    let id = reg
        .worktrees
        .iter()
        .find(|m| path_key(&m.path) == key)
        .map(|m| m.repo_id.clone())
        .or_else(|| {
            reg.repos
                .iter()
                .find(|r| path_key(&r.path) == key)
                .map(|r| r.id.clone())
        });
    Ok(id.unwrap_or(key))
}

/// The cached list of `key`, or a fresh read that is kept only when it worked.
fn candidates_with(
    cache: &Mutex<Option<HashMap<String, Vec<String>>>>,
    key: &str,
    read: impl FnOnce() -> Result<Vec<String>, CmdError>,
) -> Result<Vec<String>, CmdError> {
    let held =
        |c: &Option<HashMap<String, Vec<String>>>| c.as_ref().and_then(|m| m.get(key).cloned());
    if let Some(found) = held(&cache.lock().unwrap_or_else(PoisonError::into_inner)) {
        return Ok(found);
    }
    let list = read()?;
    cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(key.to_owned(), list.clone());
    Ok(list)
}

fn edit_with(
    gh: &dyn GhExec,
    path: &Path,
    number: u64,
    title: &str,
    body: &str,
) -> Result<(), CmdError> {
    Ok(pr_edit(gh, path, number, title, body)?)
}

fn viewed_with(gh: &dyn GhExec, path: &Path, number: u64) -> Result<PrViewed, CmdError> {
    Ok(pr_viewed_files(gh, path, number)?)
}

fn file_viewed_with(
    gh: &dyn GhExec,
    path: &Path,
    pr_id: &str,
    file: &str,
    viewed: bool,
) -> Result<(), CmdError> {
    Ok(pr_file_viewed(gh, path, pr_id, file, viewed)?)
}

fn reviewers_with(
    gh: &dyn GhExec,
    path: &Path,
    number: u64,
    add: &[String],
    remove: &[String],
) -> Result<(), CmdError> {
    Ok(pr_reviewers_edit(gh, path, number, add, remove)?)
}

#[tauri::command(async)]
pub fn worktree_pr_detail(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Option<PrDetail>, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_detail")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| detail_with(gh, &path))
}

#[tauri::command(async)]
pub fn worktree_pr_comment(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    body: String,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_comment")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        comment_with(gh, &path, number, &body)
    })
}

/// Arms auto-merge with `method`, or turns it off when `method` is `None`.
#[tauri::command(async)]
pub fn worktree_pr_auto_merge(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    method: Option<MergeMethod>,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_auto_merge")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        auto_with(gh, &path, number, method)
    })
}

/// Sets the title and body; the body goes to `gh` on stdin. Rejects with
/// `bad_pr_edit` for an empty or long title or a long body.
#[tauri::command(async)]
pub fn worktree_pr_edit(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    title: String,
    body: String,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_edit")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        edit_with(gh, &path, number, &title, &body)
    })
}

/// Asks `add` for a review and drops the request of `remove`. Logins and
/// `org/team` only; anything else rejects with `bad_reviewer`.
#[tauri::command(async)]
pub fn worktree_pr_reviewers(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_reviewers")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        reviewers_with(gh, &path, number, &add, &remove)
    })
}

/// The node id of PR `number` and the files the signed-in login marked viewed.
#[tauri::command(async)]
pub fn worktree_pr_viewed(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
) -> Result<PrViewed, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_viewed")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| viewed_with(gh, &path, number))
}

/// Marks `file` of the PR with node id `pr_id` viewed, or not.
#[tauri::command(async)]
pub fn worktree_pr_file_viewed(
    state: State<'_, AppState>,
    path: PathBuf,
    pr_id: String,
    file: String,
    viewed: bool,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_file_viewed")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        file_viewed_with(gh, &path, &pr_id, &file, viewed)
    })
}

/// The collaborators of the worktree's repo, read once per repo per session.
#[tauri::command(async)]
pub fn worktree_pr_reviewer_candidates(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Vec<String>, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_reviewer_candidates")?;
    let data = data_dir(&state)?;
    let key = repo_key(data, &path)?;
    candidates_with(&CANDIDATES, &key, || {
        let account = gh_account_for(data, &path)?;
        run_gh(&SystemGh, account, |gh| {
            Ok(pr_reviewer_candidates(gh, &path)?)
        })
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use xdev_git::{GhOutput, GitError};

    use super::*;

    struct Fake {
        calls: RefCell<Vec<(Vec<String>, Option<String>)>>,
    }

    impl GhExec for Fake {
        fn run(&self, _: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError> {
            self.calls.borrow_mut().push((
                args.iter().map(|s| s.to_string()).collect(),
                stdin.map(str::to_owned),
            ));
            Ok(GhOutput {
                status: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }

    #[test]
    fn auto_merge_none_turns_it_off_and_some_arms_it() {
        let fake = Fake {
            calls: RefCell::default(),
        };
        auto_with(&fake, Path::new("."), 9, None).unwrap();
        auto_with(&fake, Path::new("."), 9, Some(MergeMethod::Merge)).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0, ["pr", "merge", "9", "--disable-auto"]);
        assert_eq!(calls[1].0, ["pr", "merge", "9", "--auto", "--merge"]);
    }

    #[test]
    fn reviewers_pass_through_and_refuse_a_bad_name() {
        let fake = Fake {
            calls: RefCell::default(),
        };
        reviewers_with(&fake, Path::new("."), 9, &["ada".into()], &[]).unwrap();
        let err = reviewers_with(&fake, Path::new("."), 9, &["-x".into()], &[]).unwrap_err();
        assert_eq!(err.code, "bad_reviewer");
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, ["pr", "edit", "9", "--add-reviewer=ada"]);
    }

    #[test]
    fn candidates_are_read_once_per_key_and_a_failure_is_not_kept() {
        let cache = Mutex::new(None);
        let reads = RefCell::new(0);
        let fail = || {
            *reads.borrow_mut() += 1;
            Err(CmdError {
                code: "gh_failed",
                detail: None,
            })
        };
        assert!(candidates_with(&cache, "r1", fail).is_err());
        let ok = || {
            *reads.borrow_mut() += 1;
            Ok(vec!["ada".to_owned()])
        };
        assert_eq!(candidates_with(&cache, "r1", ok).unwrap(), ["ada"]);
        assert_eq!(candidates_with(&cache, "r1", fail).unwrap(), ["ada"]);
        assert_eq!(*reads.borrow(), 2);
        assert!(candidates_with(&cache, "r2", fail).is_err());
    }

    #[test]
    fn edit_puts_the_body_on_stdin_and_refuses_an_empty_title() {
        let fake = Fake {
            calls: RefCell::default(),
        };
        edit_with(&fake, Path::new("."), 9, "New", "Body").unwrap();
        let err = edit_with(&fake, Path::new("."), 9, " ", "Body").unwrap_err();
        assert_eq!(err.code, "bad_pr_edit");
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].0,
            ["pr", "edit", "9", "--title=New", "--body-file", "-"]
        );
        assert_eq!(calls[0].1.as_deref(), Some("Body"));
    }

    #[test]
    fn file_viewed_marks_and_unmarks_by_node_id() {
        let fake = Fake {
            calls: RefCell::default(),
        };
        file_viewed_with(&fake, Path::new("."), "PR_1", "a.rs", true).unwrap();
        file_viewed_with(&fake, Path::new("."), "PR_1", "a.rs", false).unwrap();
        assert!(file_viewed_with(&fake, Path::new("."), "PR 1", "a.rs", true).is_err());
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].0[3].contains("markFileAsViewed"));
        assert!(calls[1].0[3].contains("unmarkFileAsViewed"));
        assert_eq!(calls[0].0[4..], ["-f", "id=PR_1", "-f", "path=a.rs"]);
    }

    #[test]
    fn comment_body_is_stdin_only() {
        let fake = Fake {
            calls: RefCell::default(),
        };
        comment_with(&fake, Path::new("."), 9, "hello").unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0, ["pr", "comment", "9", "--body-file", "-"]);
        assert_eq!(calls[0].1.as_deref(), Some("hello"));
    }
}
