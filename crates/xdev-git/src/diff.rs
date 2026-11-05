use crate::{GitError, Repo, run};

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

impl Repo {
    /// `git diff HEAD -- <paths>` as text: what the tracked ones among
    /// `paths` change against `HEAD`, staged or not. No paths, no diff.
    pub fn diff_text(&self, paths: &[String]) -> Result<String, GitError> {
        if paths.is_empty() {
            return Ok(String::new());
        }
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "HEAD", "--"];
        args.extend(paths.iter().map(String::as_str));
        Ok(text(run::run(&self.workdir, &args, None)?))
    }

    /// `git diff <base> -- <path>` with 3 lines of context: what `path` changes
    /// between the commit `base` and the worktree. `base` must be a commit id.
    pub fn diff_file_since(&self, base: &str, path: &str) -> Result<String, GitError> {
        if !crate::history::is_commit_id(base) {
            return Err(GitError::BadId(base.to_owned()));
        }
        let args = [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "--unified=3",
            base,
            "--",
            path,
        ];
        Ok(text(run::run(&self.root(), &args, None)?))
    }

    /// Subjects of the commits in `base..HEAD`, newest first, one per line.
    pub fn range_subjects(&self, base: &str) -> Result<String, GitError> {
        let mb = self.range_start(base)?;
        let range = format!("{mb}..HEAD");
        let out = run::run(
            &self.workdir,
            &["log", "--format=%s", "--no-color", &range, "--"],
            None,
        )?;
        Ok(text(out))
    }

    /// `git diff --stat` from the merge base of `base` and `HEAD` to `HEAD`.
    pub fn range_stat(&self, base: &str) -> Result<String, GitError> {
        self.range_diff_with(base, "--stat")
    }

    /// The patch from the merge base of `base` and `HEAD` to `HEAD`.
    pub fn range_diff(&self, base: &str) -> Result<String, GitError> {
        self.range_diff_with(base, "--patch")
    }

    fn range_diff_with(&self, base: &str, mode: &str) -> Result<String, GitError> {
        let mb = self.range_start(base)?;
        let out = run::run(
            &self.workdir,
            &[
                "diff",
                mode,
                "--no-color",
                "--no-ext-diff",
                &mb,
                "HEAD",
                "--",
            ],
            None,
        )?;
        Ok(text(out))
    }

    /// The merge base, so a moved `base` does not show its own changes.
    fn range_start(&self, base: &str) -> Result<String, GitError> {
        self.merge_base(base, "HEAD")?
            .ok_or_else(|| GitError::BadId(base.to_owned()))
    }
}
