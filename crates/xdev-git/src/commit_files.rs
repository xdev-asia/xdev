//! The files one commit changed, against its first parent.

use std::collections::HashMap;

use crate::{GitError, Repo, run};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum CommitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// The name before a rename or the source of a copy.
    pub old_path: Option<String>,
    pub status: CommitFileStatus,
    /// `None` for a binary file.
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub added: Option<u64>,
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub removed: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommitFiles {
    pub id: String,
    /// The first parent; `None` for a root commit.
    pub parent: Option<String>,
    pub files: Vec<CommitFile>,
}

impl Repo {
    /// What commit `id` changed against its first parent.
    pub fn commit_files(&self, id: &str) -> Result<CommitFiles, GitError> {
        let commit = self.commit_of(id)?;
        let parent = self.first_parent(&commit)?;
        let out = match &parent {
            Some(parent) => run::run(
                &self.workdir,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-color",
                    "--raw",
                    "--numstat",
                    "-z",
                    "-M",
                    "-C",
                    parent,
                    &commit,
                    "--",
                ],
                None,
            )?,
            None => run::run(
                &self.workdir,
                &[
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--no-ext-diff",
                    "--no-color",
                    "-r",
                    "--raw",
                    "--numstat",
                    "-z",
                    "-M",
                    "-C",
                    &commit,
                    "--",
                ],
                None,
            )?,
        };
        Ok(CommitFiles {
            id: commit,
            parent,
            files: parse_files(&out),
        })
    }

    /// The first parent of commit `id`; `None` for a root commit.
    pub fn first_parent(&self, id: &str) -> Result<Option<String>, GitError> {
        let commit = self.commit_of(id)?;
        let out = run::run(
            &self.workdir,
            &["rev-list", "--parents", "-n", "1", &commit],
            None,
        )?;
        let line = String::from_utf8_lossy(&out);
        Ok(line.split_whitespace().nth(1).map(str::to_owned))
    }
}

fn status_of(letter: char) -> CommitFileStatus {
    match letter {
        'A' => CommitFileStatus::Added,
        'D' => CommitFileStatus::Deleted,
        'R' => CommitFileStatus::Renamed,
        'C' => CommitFileStatus::Copied,
        'T' => CommitFileStatus::TypeChanged,
        _ => CommitFileStatus::Modified,
    }
}

/// Parses `git diff --raw --numstat -z`: the raw records come first, then the
/// numstat records, which are matched to them by the new path.
fn parse_files(out: &[u8]) -> Vec<CommitFile> {
    let text = String::from_utf8_lossy(out);
    let mut tokens = text.split('\0').peekable();
    let mut entries: Vec<(CommitFileStatus, String, Option<String>)> = Vec::new();
    let mut counts: HashMap<String, (Option<u64>, Option<u64>)> = HashMap::new();
    while let Some(token) = tokens.next() {
        if let Some(meta) = token.strip_prefix(':') {
            let code = meta.split(' ').nth(4).unwrap_or("M");
            let status = status_of(code.chars().next().unwrap_or('M'));
            let first = tokens.next().unwrap_or_default().to_owned();
            if matches!(status, CommitFileStatus::Renamed | CommitFileStatus::Copied) {
                let second = tokens.next().unwrap_or_default().to_owned();
                entries.push((status, second, Some(first)));
            } else {
                entries.push((status, first, None));
            }
        } else if !token.is_empty() {
            let mut fields = token.splitn(3, '\t');
            let (Some(added), Some(removed), Some(path)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let path = if path.is_empty() {
                // A rename or copy: the old and the new path follow.
                let _old = tokens.next();
                tokens.next().unwrap_or_default().to_owned()
            } else {
                path.to_owned()
            };
            counts.insert(path, (added.parse().ok(), removed.parse().ok()));
        }
    }
    entries
        .into_iter()
        .map(|(status, path, old_path)| {
            let (added, removed) = counts.get(&path).copied().unwrap_or((None, None));
            CommitFile {
                path,
                old_path,
                status,
                added,
                removed,
            }
        })
        .collect()
}
