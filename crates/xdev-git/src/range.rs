use crate::history::{LOG_FORMAT, parse_log};
use crate::{Commit, GitError, Repo, run};

impl Repo {
    /// `None` before the first commit.
    pub fn head_id(&self) -> Result<Option<String>, GitError> {
        self.head()
    }

    /// The full id of the commit `rev` names. `None` when `rev` is not 4 to
    /// 40 hex digits (so branch names and `HEAD` never count) or names no
    /// commit in this repo, as in a shallow clone.
    pub fn resolve_commit(&self, rev: &str) -> Result<Option<String>, GitError> {
        if !is_hex_id(rev) {
            return Ok(None);
        }
        let rev = format!("{}^{{commit}}", rev.to_ascii_lowercase());
        let (status, out) =
            run::run_status(&self.workdir, &["rev-parse", "--verify", "-q", &rev], None)?;
        Ok((status == Some(0)).then(|| String::from_utf8_lossy(&out).trim().to_owned()))
    }

    /// The full id of the commit any ref name, remote branch or id names;
    /// `None` when it names no commit. Input that git could read as an
    /// option is refused before git sees it.
    pub fn resolve_ref(&self, rev: &str) -> Result<Option<String>, GitError> {
        if rev.is_empty() || rev.starts_with('-') || rev.chars().any(char::is_control) {
            return Err(GitError::BadId(rev.to_owned()));
        }
        let rev = format!("{rev}^{{commit}}");
        let (status, out) = run::run_status(
            &self.workdir,
            &["rev-parse", "--verify", "-q", "--end-of-options", &rev],
            None,
        )?;
        Ok((status == Some(0)).then(|| String::from_utf8_lossy(&out).trim().to_owned()))
    }

    /// The best common ancestor of two refs or ids; `None` when they share
    /// none or either names no commit.
    pub fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>, GitError> {
        let (Some(a), Some(b)) = (self.resolve_ref(a)?, self.resolve_ref(b)?) else {
            return Ok(None);
        };
        let (status, out) = run::run_status(&self.workdir, &["merge-base", &a, &b], None)?;
        Ok((status == Some(0)).then(|| String::from_utf8_lossy(&out).trim().to_owned()))
    }

    /// Commits in `since..HEAD` touching any entry, newest first, at most
    /// `limit`, and the total. Entries are repo-relative globs: `*` stays in
    /// a folder, `**` crosses folders, a plain name matches that file or
    /// everything under that folder.
    pub fn commits_since(
        &self,
        since: &str,
        covers: &[String],
        limit: usize,
    ) -> Result<(Vec<Commit>, usize), GitError> {
        match self.head()? {
            Some(head) => self.commits_between(since, &head, covers, limit),
            // Checked anyway, so a bad id fails the same before the first
            // commit.
            None => hex_id(since).map(|()| (Vec::new(), 0)),
        }
    }

    /// Like `commits_since`, for `since..until`. Both must be commit ids,
    /// never names.
    pub fn commits_between(
        &self,
        since: &str,
        until: &str,
        covers: &[String],
        limit: usize,
    ) -> Result<(Vec<Commit>, usize), GitError> {
        // Checked before git sees them, so neither can ever be read as an
        // option or a rev expression.
        hex_id(since)?;
        hex_id(until)?;
        // Without pathspecs git would count every commit.
        if covers.is_empty() {
            return Ok((Vec::new(), 0));
        }
        let range = format!("{since}..{until}");
        // `top` because entries describe code beside the vault, not in it;
        // the explicit magic also keeps an entry starting with `:` from
        // being read as magic of its own.
        let specs: Vec<String> = covers.iter().map(|c| format!(":(top,glob){c}")).collect();

        let out = run::run_magic(
            &self.workdir,
            &with_specs(&["rev-list", "--count", &range], &specs),
        )?;
        let out = String::from_utf8_lossy(&out);
        let total = out.trim().parse().map_err(|_| GitError::Failed {
            args: "rev-list --count".to_owned(),
            status: Some(0),
            stderr: out.trim().to_owned(),
        })?;
        if total == 0 || limit == 0 {
            return Ok((Vec::new(), total));
        }
        let max = format!("--max-count={limit}");
        let out = run::run_magic(
            &self.workdir,
            &with_specs(&["log", &max, LOG_FORMAT, &range], &specs),
        )?;
        Ok((parse_log(&out), total))
    }
}

fn with_specs<'a>(head: &[&'a str], specs: &'a [String]) -> Vec<&'a str> {
    let mut args = head.to_vec();
    args.push("--");
    args.extend(specs.iter().map(String::as_str));
    args
}

fn hex_id(id: &str) -> Result<(), GitError> {
    if is_hex_id(id) {
        Ok(())
    } else {
        Err(GitError::BadId(id.to_owned()))
    }
}

fn is_hex_id(id: &str) -> bool {
    (4..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit())
}
