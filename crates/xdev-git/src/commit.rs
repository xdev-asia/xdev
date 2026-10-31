use crate::{GitError, Repo, run};

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

        // Checked up front: git's own error for this is only told apart by
        // its (translated) message.
        let (status, _) = run::run_status(&self.workdir, &["var", "GIT_AUTHOR_IDENT"], None)?;
        if status != Some(0) {
            return Err(GitError::Identity);
        }

        // New files must be in the index before `commit --only` sees them.
        // A path gone from disk is skipped: after `git rm` it is in neither
        // the index nor the disk, so `add` would fail on it, and
        // `commit --only` records the deletion anyway.
        let on_disk: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|p| self.workdir.join(p).symlink_metadata().is_ok())
            .collect();
        if !on_disk.is_empty() {
            self.git_with_paths(&["add", "-A"], &on_disk, None)?;
        }

        // `--only` commits these paths from a temporary index built on
        // `HEAD`, which keeps the user's other staged files out.
        self.git_with_paths(
            &["commit", "--only", "-q", "-F", "-"],
            &paths,
            Some(message.as_bytes()),
        )?;
        let out = run::run(&self.workdir, &["rev-parse", "HEAD"], None)?;
        Ok(Some(String::from_utf8_lossy(&out).trim().to_owned()))
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
