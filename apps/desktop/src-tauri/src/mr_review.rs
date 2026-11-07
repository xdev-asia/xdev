//! Reviewing a worktree's merge request: its detail, pipeline jobs, comments, a new comment and
//! the merge. Every command runs `glab` in the repo root of the registered worktree.

use std::path::{Path, PathBuf};

use tauri::State;
use xdev_git::{
    Check, GlabExec, MergeMethod, MrDetail, MrNotes, PrMergeInfo, Repo, SystemGlab, glab_mr_detail,
    glab_mr_merge, glab_mr_merge_info, glab_mr_note_add, glab_mr_notes, glab_pipeline_jobs,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

fn detail_with(glab: &dyn GlabExec, path: &Path, iid: u64) -> Result<MrDetail, CmdError> {
    Ok(glab_mr_detail(glab, path, iid)?)
}

fn jobs_with(glab: &dyn GlabExec, path: &Path, pipeline: u64) -> Result<Vec<Check>, CmdError> {
    Ok(glab_pipeline_jobs(glab, path, pipeline)?)
}

fn notes_with(glab: &dyn GlabExec, path: &Path, iid: u64) -> Result<MrNotes, CmdError> {
    Ok(glab_mr_notes(glab, path, iid)?)
}

fn note_with(glab: &dyn GlabExec, path: &Path, iid: u64, body: &str) -> Result<(), CmdError> {
    Ok(glab_mr_note_add(glab, path, iid, body)?)
}

fn merge_info_with(glab: &dyn GlabExec, path: &Path, iid: u64) -> Result<PrMergeInfo, CmdError> {
    Ok(glab_mr_merge_info(glab, path, iid)?)
}

fn merge_with(
    glab: &dyn GlabExec,
    path: &Path,
    iid: u64,
    method: MergeMethod,
    head_sha: &str,
) -> Result<(), CmdError> {
    Ok(glab_mr_merge(glab, path, iid, method, head_sha)?)
}

/// The repo root of the worktree at `path`, where glab finds the remote.
fn root_of(state: &State<'_, AppState>, path: &Path) -> Result<PathBuf, CmdError> {
    let _ = data_dir(state)?;
    Ok(Repo::discover(path)?.root().to_path_buf())
}

#[tauri::command(async)]
pub fn worktree_mr_detail(
    state: State<'_, AppState>,
    path: PathBuf,
    iid: u64,
) -> Result<MrDetail, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_mr_detail")?;
    detail_with(&SystemGlab, &root_of(&state, &path)?, iid)
}

#[tauri::command(async)]
pub fn worktree_mr_jobs(
    state: State<'_, AppState>,
    path: PathBuf,
    pipeline_id: u64,
) -> Result<Vec<Check>, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_mr_jobs")?;
    jobs_with(&SystemGlab, &root_of(&state, &path)?, pipeline_id)
}

#[tauri::command(async)]
pub fn worktree_mr_notes(
    state: State<'_, AppState>,
    path: PathBuf,
    iid: u64,
) -> Result<MrNotes, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_mr_notes")?;
    notes_with(&SystemGlab, &root_of(&state, &path)?, iid)
}

#[tauri::command(async)]
pub fn worktree_mr_note_post(
    state: State<'_, AppState>,
    path: PathBuf,
    iid: u64,
    body: String,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_mr_note_post")?;
    note_with(&SystemGlab, &root_of(&state, &path)?, iid, &body)
}

#[tauri::command(async)]
pub fn worktree_mr_merge_info(
    state: State<'_, AppState>,
    path: PathBuf,
    iid: u64,
) -> Result<PrMergeInfo, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_mr_merge_info")?;
    merge_info_with(&SystemGlab, &root_of(&state, &path)?, iid)
}

#[tauri::command(async)]
pub fn worktree_mr_merge(
    state: State<'_, AppState>,
    path: PathBuf,
    iid: u64,
    method: MergeMethod,
    head_sha: String,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_mr_merge")?;
    merge_with(
        &SystemGlab,
        &root_of(&state, &path)?,
        iid,
        method,
        &head_sha,
    )
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use xdev_git::{GhOutput, GitError};

    use super::*;

    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        stderr: &'static str,
        status: i32,
    }

    impl Fake {
        fn new(status: i32, stderr: &'static str) -> Fake {
            Fake {
                calls: RefCell::default(),
                stderr,
                status,
            }
        }
    }

    impl GlabExec for Fake {
        fn run(&self, _: &Path, args: &[&str]) -> Result<GhOutput, GitError> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|a| a.to_string()).collect());
            Ok(GhOutput {
                status: Some(self.status),
                stdout: String::new(),
                stderr: self.stderr.into(),
            })
        }
    }

    #[test]
    fn merge_passes_the_pinned_argv_through() {
        let fake = Fake::new(0, "");
        merge_with(&fake, Path::new("."), 12, MergeMethod::Squash, "abc1234").unwrap();
        assert_eq!(
            fake.calls.borrow()[0],
            [
                "mr",
                "merge",
                "12",
                "--yes",
                "--sha=abc1234",
                "--squash",
                "--auto-merge=false"
            ]
        );
    }

    #[test]
    fn a_blank_comment_is_an_empty_comment_error() {
        let fake = Fake::new(0, "");
        let err = note_with(&fake, Path::new("."), 12, "  ").unwrap_err();
        assert_eq!(err.code, "empty_comment");
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn a_moved_head_and_a_blocked_merge_keep_their_codes() {
        let moved = Fake::new(1, "SHA does not match HEAD of source branch");
        let err =
            merge_with(&moved, Path::new("."), 12, MergeMethod::Merge, "abc1234").unwrap_err();
        assert_eq!(err.code, "pr_head_moved");
        let blocked = Fake::new(1, "Merge request is not mergeable");
        let err =
            merge_with(&blocked, Path::new("."), 12, MergeMethod::Merge, "abc1234").unwrap_err();
        assert_eq!(err.code, "merge_blocked");
        assert_eq!(err.detail.as_deref(), Some("blocked"));
    }
}
