use xdev_git::{Commit, GitError, Repo};
use xdev_vault::{Vault, extract_title, parse_frontmatter};

use crate::CoreError;

/// At most this many commits are listed; `count` still has them all.
pub const FRESHNESS_COMMITS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocState {
    /// The doc declares no `covers`.
    None,
    Fresh,
    Stale,
    /// `covers` without a usable `verified`.
    Unverified,
    /// No git, `verified` is not a commit in the repo (a shallow clone), or
    /// git fails on this doc's commits.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Freshness {
    pub state: DocState,
    pub covers: Vec<String>,
    /// As the frontmatter has it, not resolved to a full id.
    pub verified: Option<String>,
    /// So the UI can mark the doc verified now.
    pub head: Option<String>,
    /// Newest first, at most `FRESHNESS_COMMITS`.
    pub commits: Vec<Commit>,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StaleDoc {
    pub path: String,
    pub title: String,
    pub state: DocState,
    pub count: usize,
}

/// Reads the saved file, so the answer follows saves rather than commits.
pub fn freshness(vault: &Vault, repo: Option<&Repo>, path: &str) -> Result<Freshness, CoreError> {
    let content = vault.read(path)?;
    let (fm, _) = parse_frontmatter(&content);
    let head = match repo {
        Some(repo) => repo.head_id()?,
        None => None,
    };
    let (state, commits, count) =
        check(repo, &fm.covers, fm.verified.as_deref(), FRESHNESS_COMMITS)?;
    Ok(Freshness {
        state,
        covers: fm.covers,
        verified: fm.verified,
        head,
        commits,
        count,
    })
}

/// Docs whose state is stale, unverified or unknown, sorted by path. A doc
/// that cannot be read is left out, as the index leaves it out.
pub fn stale_docs(vault: &Vault, repo: Option<&Repo>) -> Result<Vec<StaleDoc>, CoreError> {
    let mut out = Vec::new();
    for meta in vault.list()? {
        let Ok(content) = vault.read(&meta.path) else {
            continue;
        };
        let (fm, _) = parse_frontmatter(&content);
        if fm.covers.is_empty() {
            continue;
        }
        let (state, _, count) = check(repo, &fm.covers, fm.verified.as_deref(), 0)?;
        if matches!(
            state,
            DocState::Stale | DocState::Unverified | DocState::Unknown
        ) {
            out.push(StaleDoc {
                title: extract_title(&meta.path, &content),
                path: meta.path,
                state,
                count,
            });
        }
    }
    Ok(out)
}

fn check(
    repo: Option<&Repo>,
    covers: &[String],
    verified: Option<&str>,
    limit: usize,
) -> Result<(DocState, Vec<Commit>, usize), CoreError> {
    if covers.is_empty() {
        return Ok((DocState::None, Vec::new(), 0));
    }
    // Checked before git, so a doc nobody confirmed reads the same in CI and
    // outside a repo.
    let Some(verified) = verified else {
        return Ok((DocState::Unverified, Vec::new(), 0));
    };
    let Some(repo) = repo else {
        return Ok((DocState::Unknown, Vec::new(), 0));
    };
    let Some(since) = repo.resolve_commit(verified)? else {
        return Ok((DocState::Unknown, Vec::new(), 0));
    };
    // A failure tied to this doc's range or covers must not hide every other
    // doc; one that means git is unusable still propagates.
    let (commits, count) = match repo.commits_since(&since, covers, limit) {
        Ok(found) => found,
        Err(GitError::Failed { .. } | GitError::BadId(_)) => {
            return Ok((DocState::Unknown, Vec::new(), 0));
        }
        Err(e) => return Err(e.into()),
    };
    let state = if count > 0 {
        DocState::Stale
    } else {
        DocState::Fresh
    };
    Ok((state, commits, count))
}
