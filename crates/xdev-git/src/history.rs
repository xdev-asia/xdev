use crate::{GitError, Repo, run};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Commit {
    pub id: String,
    pub author: String,
    /// Unix seconds.
    pub time: i64,
    /// Subject line only.
    pub message: String,
}

impl Repo {
    /// `None` when the repo has no commits yet or the file is not in `HEAD`.
    pub fn head_content(&self, path: &str) -> Result<Option<Vec<u8>>, GitError> {
        let Some(head) = self.head()? else {
            return Ok(None);
        };
        self.blob(&head, path)
    }

    /// `None` when the file did not exist in that commit.
    pub fn show(&self, id: &str, path: &str) -> Result<Option<Vec<u8>>, GitError> {
        let commit = self.commit_of(id)?;
        self.blob(&commit, path)
    }

    /// The full id of commit `id`, which must be plain hex.
    pub(crate) fn commit_of(&self, id: &str) -> Result<String, GitError> {
        // Checked before git sees it, so an id can never be read as an
        // option or a rev expression.
        if !is_commit_id(id) {
            return Err(GitError::BadId(id.to_owned()));
        }
        let rev = format!("{id}^{{commit}}");
        let out = run::run(&self.workdir, &["rev-parse", "--verify", "-q", &rev], None)?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    }

    /// The file's size in that commit without reading it, so a caller can
    /// refuse a large file first. `None` when it is absent or not a file.
    pub fn blob_size(&self, id: &str, path: &str) -> Result<Option<u64>, GitError> {
        let commit = self.commit_of(id)?;
        // `<rev>:<path>` is relative to the repo's top, not the vault folder.
        let object = format!("{commit}:{}{path}", self.prefix);
        let (status, kind) = run::run_status(&self.workdir, &["cat-file", "-t", &object], None)?;
        if status != Some(0) || String::from_utf8_lossy(&kind).trim() != "blob" {
            return Ok(None);
        }
        let out = run::run(&self.workdir, &["cat-file", "-s", &object], None)?;
        Ok(String::from_utf8_lossy(&out).trim().parse().ok())
    }

    /// Newest first. History does not follow renames.
    pub fn log(&self, path: &str, limit: usize) -> Result<Vec<Commit>, GitError> {
        if self.head()?.is_none() {
            return Ok(Vec::new());
        }
        let limit = format!("-n{limit}");
        let out = run::run(
            &self.workdir,
            &["log", &limit, LOG_FORMAT, "--", path],
            None,
        )?;
        Ok(parse_log(&out))
    }

    /// The `HEAD` commit id, or `None` before the first commit.
    pub(crate) fn head(&self) -> Result<Option<String>, GitError> {
        let (status, out) = run::run_status(
            &self.workdir,
            &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
            None,
        )?;
        Ok((status == Some(0)).then(|| String::from_utf8_lossy(&out).trim().to_owned()))
    }

    fn blob(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, GitError> {
        // `ls-tree` paths are relative to the vault folder, like every other
        // call; its object id avoids parsing `rev:path` a second time.
        let out = run::run(&self.workdir, &["ls-tree", "-z", rev, "--", path], None)?;
        let entry = out.split(|b| *b == 0).next().unwrap_or_default();
        let Some(meta) = entry.split(|b| *b == b'\t').next() else {
            return Ok(None);
        };
        // `<mode> SP <type> SP <object>`; a folder or submodule is not a doc.
        let meta = String::from_utf8_lossy(meta);
        let mut parts = meta.split(' ');
        let (Some(_mode), Some("blob"), Some(object)) = (parts.next(), parts.next(), parts.next())
        else {
            return Ok(None);
        };
        Ok(Some(run::run(
            &self.workdir,
            &["cat-file", "blob", object],
            None,
        )?))
    }
}

pub(crate) const LOG_FORMAT: &str = "--format=%H%x1f%an%x1f%at%x1f%s%x1e";

/// Parses `git log` output written with `LOG_FORMAT`.
pub(crate) fn parse_log(out: &[u8]) -> Vec<Commit> {
    String::from_utf8_lossy(out)
        .split('\x1e')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').splitn(4, '\x1f');
            Some(Commit {
                id: fields.next().filter(|id| !id.is_empty())?.to_owned(),
                author: fields.next()?.to_owned(),
                time: fields.next()?.parse().ok()?,
                message: fields.next()?.to_owned(),
            })
        })
        .collect()
}

pub(crate) fn is_commit_id(id: &str) -> bool {
    (4..=64).contains(&id.len()) && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
