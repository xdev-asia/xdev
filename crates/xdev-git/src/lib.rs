//! Runs the `git` program for the vault's repo: pending changes, versions,
//! history, commit and restore. Paths in and out are vault-relative with `/`.

mod commit;
mod history;
mod range;
mod run;
mod status;
mod worktree;

use std::path::{Path, PathBuf};

pub use history::Commit;
pub use worktree::NumStat;

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
    #[error("timeout")]
    Timeout,
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
