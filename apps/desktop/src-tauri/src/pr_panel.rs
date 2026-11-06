//! The pull request panel of a worktree: the PR of its branch in full, a
//! comment, and auto-merge on or off. Every command runs `gh` as the login the
//! repo is bound to, in the registered worktree.

use std::path::{Path, PathBuf};

use tauri::State;
use xdev_git::{
    GhExec, MergeMethod, PrDetail, SystemGh, pr_auto_merge_disable, pr_auto_merge_enable,
    pr_comment_add, pr_detail,
};

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
