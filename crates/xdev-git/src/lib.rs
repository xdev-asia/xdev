//! Runs the `git` program for the vault's repo: pending changes, versions,
//! history, commit and restore. Paths in and out are vault-relative with `/`.

mod clone;
mod commit;
mod conflict;
mod diff;
mod gh;
mod history;
mod range;
mod remote;
mod review;
mod run;
mod since;
mod status;
mod worktree;

use std::path::{Path, PathBuf};

pub use clone::{CloneEvent, check_clone_url, clone_name, clone_repo, parse_progress};
pub use conflict::{ConflictOp, ConflictState};
pub use gh::{
    Check, CheckBucket, GhAccount, GhEnv, GhExec, GhLogin, GhOutput, ISSUE_BODY_MAX,
    ISSUE_LIMIT_MAX, Issue, IssueComment, IssueDetail, IssueQuery, IssueState, PrDraft, PrState,
    PrView, SystemGh, TokenGh, gh_logins, issue_list, issue_open_web, issue_view, parse_issue_ref,
    pr_checks, pr_create, pr_open_web, pr_view, repo_name, run_failed_log,
};
pub use history::Commit;
pub use remote::{BaseRange, BaseRefresh, Upstream};
pub use review::{Branch, StageState};
pub use worktree::{NumStat, WorktreeEntry, global_user_name, valid_branch_name};

/// The UI translates `code()`, never the message.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git not found")]
    NoGit,
    #[error("not a git work tree")]
    NoRepo,
    #[error("git has no user name or email")]
    Identity,
    #[error("bad commit id: {0}")]
    BadId(String),
    #[error("the repo has no remote to use")]
    NoRemote,
    #[error("the branch has no upstream")]
    NoUpstream,
    #[error("HEAD is detached")]
    Detached,
    #[error("push rejected: {0}")]
    Rejected(String),
    #[error("local and remote history have diverged")]
    Diverged,
    #[error("gh not found")]
    GhMissing,
    /// The login a repo is bound to is no longer in `gh`.
    #[error("the bound gh login is gone")]
    GhAccountMissing,
    #[error("gh is not logged in")]
    GhAuth,
    #[error("the repo has no GitHub remote")]
    NotGithub,
    #[error("gh failed: {0}")]
    Gh(String),
    #[error("no such issue")]
    IssueNotFound,
    #[error("the issue belongs to another repo: {0}")]
    IssueOtherRepo(String),
    #[error("a commit hook failed: {output}")]
    Hook { output: String },
    #[error("a file is still unmerged")]
    StillConflicted,
    #[error("no merge, rebase, cherry-pick or revert in progress")]
    NoConflict,
    #[error("timeout")]
    Timeout,
    #[error("not a clone URL xDev accepts: {0}")]
    BadUrl(String),
    #[error("cancelled")]
    Cancelled,
    #[error("git {args} failed ({status:?}): {stderr}")]
    Failed {
        args: String,
        status: Option<i32>,
        stderr: String,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl GitError {
    pub fn code(&self) -> &'static str {
        match self {
            GitError::NoGit => "no_git",
            GitError::NoRepo => "no_repo",
            GitError::Identity => "git_identity",
            GitError::NoRemote => "no_remote",
            GitError::NoUpstream => "no_upstream",
            GitError::Detached => "detached",
            GitError::Rejected(_) => "push_rejected",
            GitError::Diverged => "pull_diverged",
            GitError::GhMissing => "gh_missing",
            GitError::GhAuth => "gh_auth",
            GitError::GhAccountMissing => "gh_account_missing",
            GitError::NotGithub => "not_github",
            GitError::Gh(_) => "gh_failed",
            GitError::IssueNotFound => "issue_not_found",
            GitError::IssueOtherRepo(_) => "issue_other_repo",
            GitError::Hook { .. } => "hook_failed",
            GitError::BadUrl(_) => "bad_arg",
            GitError::Cancelled => "cancelled",
            GitError::StillConflicted => "still_conflicted",
            GitError::NoConflict => "no_conflict",
            GitError::BadId(_) | GitError::Timeout | GitError::Failed { .. } => "git",
            GitError::Io(_) => "io",
        }
    }
}

/// Compared with `HEAD`: not in `HEAD` is added, not on disk is deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStatus {
    pub path: String,
    pub kind: ChangeKind,
}

/// The repo that contains a vault. Git runs in the vault folder with
/// vault-relative pathspecs, so files outside the vault never show.
#[derive(Debug, Clone)]
pub struct Repo {
    workdir: PathBuf,
    /// The vault's folder inside the repo: `""` or `"sub/dir/"`.
    prefix: String,
}

impl Repo {
    pub fn discover(dir: &Path) -> Result<Repo, GitError> {
        let (status, out) = run::run_status(
            dir,
            &["rev-parse", "--is-inside-work-tree", "--show-prefix"],
            None,
        )?;
        let out = String::from_utf8_lossy(&out);
        let mut lines = out.lines();
        // Inside `.git` or a bare repo git answers `false` with exit 0.
        if status != Some(0) || lines.next() != Some("true") {
            return Err(GitError::NoRepo);
        }
        Ok(Repo {
            workdir: dir.to_path_buf(),
            prefix: lines.next().unwrap_or_default().to_owned(),
        })
    }

    pub fn init(dir: &Path) -> Result<Repo, GitError> {
        run::run(dir, &["init", "-q"], None)?;
        Repo::discover(dir)
    }

    /// `git init` with `branch` as the first branch. Git older than 2.28
    /// does not know `--initial-branch`: it gets a plain `init` and `HEAD`
    /// is pointed at the branch by hand.
    pub fn init_on(dir: &Path, branch: &str) -> Result<Repo, GitError> {
        let flag = format!("--initial-branch={branch}");
        if run::run(dir, &["init", "-q", &flag], None).is_err() {
            run::run(dir, &["init", "-q"], None)?;
            let full = format!("refs/heads/{branch}");
            run::run(dir, &["symbolic-ref", "HEAD", &full], None)?;
        }
        Repo::discover(dir)
    }

    /// The repo's top folder. Derived from the prefix, so it keeps the form of
    /// the vault path the caller gave and needs no extra git run.
    pub fn root(&self) -> PathBuf {
        let mut root = self.workdir.clone();
        for _ in self.prefix.split('/').filter(|s| !s.is_empty()) {
            root.pop();
        }
        root
    }
}
