//! Reviewing a worktree's pull request: its comments, replies, resolving,
//! reactions, rerunning checks and merging. Every command runs `gh` as the
//! login the repo is bound to, in the registered worktree.

use std::path::{Path, PathBuf};

use tauri::State;
use xdev_git::{
    GhExec, MergeMethod, PrCommentDraft, PrComments, PrMergeInfo, Reaction, RerunReport, SystemGh,
    pr_checks_rerun, pr_comment_post, pr_comments, pr_head_oid, pr_merge, pr_merge_info,
    pr_reaction, pr_thread_resolve,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::ship::{gh_account_for, run_gh};

fn comments_with(gh: &dyn GhExec, path: &Path, number: u64) -> Result<PrComments, CmdError> {
    Ok(pr_comments(gh, path, number)?)
}

fn post_with(
    gh: &dyn GhExec,
    path: &Path,
    number: u64,
    draft: &PrCommentDraft,
) -> Result<(), CmdError> {
    Ok(pr_comment_post(gh, path, number, draft)?)
}

fn resolve_with(
    gh: &dyn GhExec,
    path: &Path,
    thread_id: &str,
    resolved: bool,
) -> Result<(), CmdError> {
    Ok(pr_thread_resolve(gh, path, thread_id, resolved)?)
}

fn reaction_with(
    gh: &dyn GhExec,
    path: &Path,
    subject_id: &str,
    content: Reaction,
    on: bool,
) -> Result<(), CmdError> {
    Ok(pr_reaction(gh, path, subject_id, content, on)?)
}

fn rerun_with(
    gh: &dyn GhExec,
    path: &Path,
    number: u64,
    failed_only: bool,
) -> Result<RerunReport, CmdError> {
    Ok(pr_checks_rerun(gh, path, number, failed_only)?)
}

fn merge_info_with(gh: &dyn GhExec, path: &Path, number: u64) -> Result<PrMergeInfo, CmdError> {
    Ok(pr_merge_info(gh, path, number)?)
}

fn merge_with(
    gh: &dyn GhExec,
    path: &Path,
    number: u64,
    method: MergeMethod,
    head_oid: &str,
) -> Result<(), CmdError> {
    Ok(pr_merge(gh, path, number, method, head_oid)?)
}

#[tauri::command(async)]
pub fn worktree_pr_comments(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
) -> Result<PrComments, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_comments")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| comments_with(gh, &path, number))
}

#[tauri::command(async)]
pub fn worktree_pr_comment_post(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    draft: PrCommentDraft,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_comment_post")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        post_with(gh, &path, number, &draft)
    })
}

/// The PR's head commit on GitHub, to compare with the worktree `HEAD`.
#[tauri::command(async)]
pub fn worktree_pr_head(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
) -> Result<String, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_head")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| Ok(pr_head_oid(gh, &path, number)?))
}

#[tauri::command(async)]
pub fn worktree_pr_thread_resolve(
    state: State<'_, AppState>,
    path: PathBuf,
    thread_id: String,
    resolved: bool,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_thread_resolve")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        resolve_with(gh, &path, &thread_id, resolved)
    })
}

#[tauri::command(async)]
pub fn worktree_pr_reaction(
    state: State<'_, AppState>,
    path: PathBuf,
    subject_id: String,
    content: Reaction,
    on: bool,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_reaction")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        reaction_with(gh, &path, &subject_id, content, on)
    })
}

#[tauri::command(async)]
pub fn worktree_pr_checks_rerun(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    failed_only: bool,
) -> Result<RerunReport, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_checks_rerun")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        rerun_with(gh, &path, number, failed_only)
    })
}

#[tauri::command(async)]
pub fn worktree_pr_merge_info(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
) -> Result<PrMergeInfo, CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_merge_info")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| merge_info_with(gh, &path, number))
}

#[tauri::command(async)]
pub fn worktree_pr_merge(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
    method: MergeMethod,
    head_oid: String,
) -> Result<(), CmdError> {
    crate::remote_ssh::local_only(&path, "worktree_pr_merge")?;
    let account = gh_account_for(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, account, |gh| {
        merge_with(gh, &path, number, method, &head_oid)
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use xdev_git::{GhAccount, GhEnv, GhOutput, GitError};

    use super::*;

    type EnvCall = (Vec<String>, Vec<(String, String)>);

    /// A `gh` that answers every call with the same output and records the
    /// environment of each.
    struct EnvGh {
        calls: RefCell<Vec<EnvCall>>,
        reply: GhOutput,
    }

    impl EnvGh {
        fn new(stdout: &str) -> EnvGh {
            EnvGh {
                calls: RefCell::default(),
                reply: GhOutput {
                    status: Some(0),
                    stdout: stdout.into(),
                    stderr: String::new(),
                },
            }
        }
    }

    impl GhEnv for EnvGh {
        fn run_env(
            &self,
            _: &Path,
            args: &[&str],
            _: Option<&str>,
            env: &[(&str, &str)],
        ) -> Result<GhOutput, GitError> {
            self.calls.borrow_mut().push((
                args.iter().map(|a| a.to_string()).collect(),
                env.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
            // The token lookup answers with a token; every other call with the reply.
            let stdout = if args.first() == Some(&"auth") {
                "gho_x\n".to_owned()
            } else {
                self.reply.stdout.clone()
            };
            Ok(GhOutput {
                status: self.reply.status,
                stdout,
                stderr: self.reply.stderr.clone(),
            })
        }
    }

    fn bound() -> Option<GhAccount> {
        Some(GhAccount {
            host: "github.com".into(),
            user: "u".into(),
        })
    }

    /// Runs `f` as the bound login and returns the calls it made after the
    /// token lookup.
    fn calls_of(reply: &str, f: impl FnOnce(&dyn GhExec)) -> Vec<EnvCall> {
        let inner = EnvGh::new(reply);
        run_gh(&inner, bound(), f);
        let calls = inner.calls.borrow();
        assert_eq!(calls[0].0[0], "auth", "the token is read first");
        calls.iter().filter(|c| c.0[0] != "auth").cloned().collect()
    }

    fn assert_token(calls: &[EnvCall]) {
        assert!(!calls.is_empty());
        for (args, env) in calls {
            assert_eq!(
                env,
                &[("GH_TOKEN".to_owned(), "gho_x".to_owned())],
                "{args:?}"
            );
        }
    }

    const REPO: &str = r#"{"nameWithOwner":"acme/app"}"#;

    #[test]
    fn every_command_runs_as_the_bound_login() {
        let p = Path::new(".");
        let draft = PrCommentDraft {
            body: "hi".into(),
            reply_to: None,
            path: None,
            line: None,
            start_line: None,
            commit: None,
        };
        assert_token(&calls_of(REPO, |gh| {
            let _ = comments_with(gh, p, 7);
        }));
        assert_token(&calls_of(REPO, |gh| {
            let _ = post_with(gh, p, 7, &draft);
        }));
        assert_token(&calls_of("{}", |gh| {
            let _ = resolve_with(gh, p, "T", true);
        }));
        assert_token(&calls_of("{}", |gh| {
            let _ = reaction_with(gh, p, "C", Reaction::Heart, true);
        }));
        let checks = r#"[{"name":"a","state":"X","bucket":"fail","link":"https://x/actions/runs/1/job/2","workflow":"CI"}]"#;
        let rerun = calls_of(checks, |gh| {
            assert_eq!(rerun_with(gh, p, 7, true).unwrap().started, 1);
        });
        assert_token(&rerun);
        assert_eq!(rerun.len(), 2);
        assert_token(&calls_of("{}", |gh| {
            let _ = merge_info_with(gh, p, 7);
        }));
        let merged = calls_of("", |gh| {
            merge_with(gh, p, 7, MergeMethod::Squash, "abc123").unwrap()
        });
        assert_token(&merged);
        assert_eq!(
            merged[0].0,
            [
                "pr",
                "merge",
                "7",
                "--squash",
                "--match-head-commit",
                "abc123"
            ]
        );
    }

    #[test]
    fn a_blocked_merge_surfaces_its_block_as_the_detail() {
        let inner = EnvGh {
            calls: RefCell::default(),
            reply: GhOutput {
                status: Some(1),
                stdout: String::new(),
                stderr: "Pull request is a draft".into(),
            },
        };
        let err = run_gh(&inner, None, |gh| {
            merge_with(gh, Path::new("."), 7, MergeMethod::Merge, "abc123")
        })
        .unwrap_err();
        assert_eq!(err.code, "merge_blocked");
        assert_eq!(err.detail.as_deref(), Some("draft"));
    }
}
