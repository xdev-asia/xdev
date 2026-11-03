use std::path::PathBuf;

use crate::{GitError, Repo, run};

/// The last `max` bytes of `text`, cut on a char boundary.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

impl Repo {
    /// Commits exactly `paths` as they are on disk and returns the new `HEAD`
    /// id, or `None` when none of them differs from `HEAD`. Anything else the
    /// user staged stays staged and out of the commit.
    pub fn commit(&self, paths: &[String], message: &str) -> Result<Option<String>, GitError> {
        if paths.is_empty() {
            return Ok(None);
        }
        // Only paths git reports as changed go further: an unknown path
        // would fail `add` and `commit`.
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        let pending = self.status_of(&paths)?;
        if pending.is_empty() {
            return Ok(None);
        }
        let paths: Vec<&str> = pending.iter().map(|s| s.path.as_str()).collect();

        self.check_identity()?;
        self.stage_new(&paths)?;

        // `--only` commits these paths from a temporary index built on
        // `HEAD`, which keeps the user's other staged files out.
        self.commit_cmd(&["commit", "--only", "-q", "-F", "-"], &paths, message)?;
        Ok(Some(self.rev_head()?))
    }

    /// Rewrites `HEAD` with `message` and the current disk content of the
    /// changed ones among `paths`; no paths only rewords. Returns the new
    /// `HEAD` id. Whether `HEAD` may be rewritten is the caller's call.
    pub fn amend(&self, paths: &[String], message: &str) -> Result<String, GitError> {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        let pending = if paths.is_empty() {
            Vec::new()
        } else {
            self.status_of(&paths)?
        };
        let paths: Vec<&str> = pending.iter().map(|s| s.path.as_str()).collect();

        self.check_identity()?;
        self.stage_new(&paths)?;
        self.commit_cmd(
            &["commit", "--amend", "--only", "-q", "-F", "-"],
            &paths,
            message,
        )?;
        self.rev_head()
    }

    /// Where git looks for hooks. A relative `core.hooksPath` is relative to
    /// the work tree's top folder, where git runs the hooks.
    pub fn hooks_dir(&self) -> Result<PathBuf, GitError> {
        let (status, out) =
            run::run_status(&self.workdir, &["config", "--get", "core.hooksPath"], None)?;
        let configured = String::from_utf8_lossy(&out).trim().to_owned();
        if status == Some(0) && !configured.is_empty() {
            return Ok(self.root().join(configured));
        }
        let out = run::run(&self.workdir, &["rev-parse", "--git-path", "hooks"], None)?;
        Ok(self.workdir.join(String::from_utf8_lossy(&out).trim()))
    }

    fn has_commit_hook(&self) -> bool {
        let Ok(dir) = self.hooks_dir() else {
            return false;
        };
        ["pre-commit", "prepare-commit-msg", "commit-msg"]
            .iter()
            .any(|name| dir.join(name).is_file())
    }

    /// Checked up front: git's own error for this is only told apart by its
    /// (translated) message.
    fn check_identity(&self) -> Result<(), GitError> {
        let (status, _) = run::run_status(&self.workdir, &["var", "GIT_AUTHOR_IDENT"], None)?;
        if status != Some(0) {
            return Err(GitError::Identity);
        }
        Ok(())
    }

    /// New files must be in the index before `commit --only` sees them.
    /// A path gone from disk is skipped: after `git rm` it is in neither
    /// the index nor the disk, so `add` would fail on it, and
    /// `commit --only` records the deletion anyway.
    fn stage_new(&self, paths: &[&str]) -> Result<(), GitError> {
        let on_disk: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|p| self.workdir.join(p).symlink_metadata().is_ok())
            .collect();
        if !on_disk.is_empty() {
            self.git_with_paths(&["add", "-A"], &on_disk, None)?;
        }
        Ok(())
    }

    /// Runs `git commit`. A failure with a hook in place is reported as the
    /// hook's output: git itself prints nothing useful for it.
    fn commit_cmd(&self, args: &[&str], paths: &[&str], message: &str) -> Result<(), GitError> {
        let mut all = args.to_vec();
        if !paths.is_empty() {
            all.push("--");
            all.extend_from_slice(paths);
        }
        let out = run::run_output(&self.workdir, &all, Some(message.as_bytes()))?;
        if out.status == Some(0) {
            return Ok(());
        }
        if self.has_commit_hook() {
            // The end is what a hook ends with: its verdict.
            let mut text = String::from_utf8_lossy(&out.stderr).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stdout));
            return Err(GitError::Hook {
                output: tail(text.trim(), 8000),
            });
        }
        Err(GitError::Failed {
            args: all.join(" "),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        })
    }

    fn rev_head(&self) -> Result<String, GitError> {
        let out = run::run(&self.workdir, &["rev-parse", "HEAD"], None)?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    }

    /// Puts tracked paths back to their `HEAD` content, in the index and on
    /// disk.
    pub fn restore(&self, paths: &[String]) -> Result<(), GitError> {
        self.git_with_strings(
            &["restore", "--source=HEAD", "--staged", "--worktree"],
            paths,
        )
    }

    /// Takes paths out of the index; the files stay on disk.
    pub fn unstage(&self, paths: &[String]) -> Result<(), GitError> {
        self.git_with_strings(&["rm", "--cached", "-q", "--ignore-unmatch"], paths)
    }

    fn git_with_strings(&self, args: &[&str], paths: &[String]) -> Result<(), GitError> {
        // Git refuses these commands without a path.
        if paths.is_empty() {
            return Ok(());
        }
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        self.git_with_paths(args, &paths, None).map(drop)
    }

    /// User paths always go after `--`, so `-x.md` is a file, not an option.
    fn git_with_paths(
        &self,
        args: &[&str],
        paths: &[&str],
        stdin: Option<&[u8]>,
    ) -> Result<Vec<u8>, GitError> {
        let mut all = args.to_vec();
        all.push("--");
        all.extend_from_slice(paths);
        run::run(&self.workdir, &all, stdin)
    }
}
