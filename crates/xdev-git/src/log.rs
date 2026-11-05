//! The commit graph of `HEAD` for the history panel.

use crate::{GitError, Repo, run};

/// Commits per page the UI asks for.
pub const LOG_LIMIT: usize = 50;
/// The most commits one call returns.
pub const LOG_LIMIT_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

/// A name that points at a commit, without `refs/heads/`, `refs/remotes/`
/// or `refs/tags/`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub name: String,
    pub kind: RefKind,
}

/// A named ref and the commit it points at.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LogRef {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Author time, Unix seconds.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub time: i64,
    /// `""` when the message is empty.
    pub subject: String,
    pub body: String,
    pub refs: Vec<CommitRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RepoLog {
    /// `HEAD` first, in topological order.
    pub commits: Vec<LogCommit>,
    /// `None` when `HEAD` is unborn.
    pub head: Option<String>,
    /// `None` when `HEAD` is detached or unborn.
    pub branch: Option<String>,
    pub upstream: Option<LogRef>,
    /// `None` when there is no base, or it is the upstream itself.
    pub base: Option<LogRef>,
    pub merge_base: Option<String>,
    /// The upstream has commits `HEAD` lacks.
    pub incoming: bool,
    /// `HEAD` is not the merge base.
    pub outgoing: bool,
    pub has_more: bool,
}

const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%D%x1f%B";

impl Repo {
    /// The log of `HEAD`, `limit` commits after `skip`. Only `HEAD` is
    /// walked; the upstream and the base are metadata for the graph.
    pub fn repo_log(
        &self,
        base: Option<&str>,
        limit: usize,
        skip: usize,
    ) -> Result<RepoLog, GitError> {
        let Some(head) = self.head()? else {
            return Ok(RepoLog {
                commits: Vec::new(),
                head: None,
                branch: None,
                upstream: None,
                base: None,
                merge_base: None,
                incoming: false,
                outgoing: false,
                has_more: false,
            });
        };
        let branch = self.current_branch()?;
        let up = self.upstream()?;
        let upstream = up.as_ref().and_then(|u| {
            u.id.as_ref().map(|id| LogRef {
                name: format!("{}/{}", u.remote, u.branch),
                id: id.clone(),
            })
        });
        let mut base_ref = None;
        if let Some(name) = base.filter(|b| !b.is_empty())
            && let Some(id) = self.resolve_ref(name)?
            && upstream.as_ref().is_none_or(|u| u.id != id)
        {
            base_ref = Some(LogRef {
                name: name.to_owned(),
                id,
            });
        }
        let against = base_ref.as_ref().or(upstream.as_ref());
        let merge_base = match against {
            Some(r) => self.merge_base(&r.id, &head)?,
            None => None,
        };
        let outgoing = merge_base.as_ref().is_some_and(|mb| *mb != head);
        let incoming = up.as_ref().is_some_and(|u| u.behind > 0);

        let count = format!("-n{}", limit.saturating_add(1));
        let skip_arg = format!("--skip={skip}");
        let mut args = vec![
            "log",
            "--no-show-signature",
            "--no-color",
            "--topo-order",
            "--decorate=full",
            "-z",
            LOG_FORMAT,
            &count,
        ];
        if skip > 0 {
            args.push(&skip_arg);
        }
        args.extend([head.as_str(), "--"]);
        let out = run::run(&self.workdir, &args, None)?;
        let mut commits: Vec<LogCommit> = out
            .split(|b| *b == 0)
            .filter(|r| !r.is_empty())
            .filter_map(parse_commit)
            .collect();
        let has_more = commits.len() > limit;
        commits.truncate(limit);
        Ok(RepoLog {
            commits,
            head: Some(head),
            branch,
            upstream,
            base: base_ref,
            merge_base,
            incoming,
            outgoing,
            has_more,
        })
    }
}

fn parse_commit(record: &[u8]) -> Option<LogCommit> {
    let record = String::from_utf8_lossy(record);
    let mut fields = record.trim_start_matches('\n').splitn(7, '\x1f');
    let id = fields.next().filter(|id| !id.is_empty())?.to_owned();
    let parents = fields
        .next()?
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let author = fields.next()?.to_owned();
    let email = fields.next()?.to_owned();
    let time = fields.next()?.parse().ok()?;
    let refs = parse_refs(fields.next()?);
    let message = fields.next()?.trim_end_matches(['\n', '\r']);
    let (subject, body) = match message.split_once('\n') {
        Some((subject, rest)) => (
            subject.trim_end_matches('\r'),
            rest.trim_matches(['\n', '\r']),
        ),
        None => (message, ""),
    };
    Some(LogCommit {
        id,
        parents,
        author,
        email,
        time,
        subject: subject.to_owned(),
        body: body.to_owned(),
        refs,
    })
}

/// `%D` with full names: `HEAD -> refs/heads/main, tag: refs/tags/v1, ...`.
fn parse_refs(decorations: &str) -> Vec<CommitRef> {
    decorations
        .split(", ")
        .filter_map(|item| {
            let item = item.trim();
            let item = item.strip_prefix("HEAD -> ").unwrap_or(item);
            if let Some(tag) = item.strip_prefix("tag: refs/tags/") {
                return Some(CommitRef {
                    name: tag.to_owned(),
                    kind: RefKind::Tag,
                });
            }
            if let Some(name) = item.strip_prefix("refs/heads/") {
                return Some(CommitRef {
                    name: name.to_owned(),
                    kind: RefKind::Branch,
                });
            }
            let name = item.strip_prefix("refs/remotes/")?;
            if name.ends_with("/HEAD") {
                return None;
            }
            Some(CommitRef {
                name: name.to_owned(),
                kind: RefKind::Remote,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decorations() {
        let refs = parse_refs(
            "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/stash",
        );
        let got: Vec<(&str, RefKind)> = refs.iter().map(|r| (r.name.as_str(), r.kind)).collect();
        assert_eq!(
            got,
            [
                ("main", RefKind::Branch),
                ("v1", RefKind::Tag),
                ("origin/main", RefKind::Remote)
            ]
        );
        assert!(parse_refs("").is_empty());
        assert!(parse_refs("HEAD").is_empty());
    }
}
