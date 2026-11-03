use std::collections::BTreeMap;

use xdev_git::{Commit, GitError, Repo};
use xdev_vault::{Vault, extract_title, parse_frontmatter};

use crate::CoreError;

/// At most this many commits are listed; `count` still has them all.
pub const FRESHNESS_COMMITS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
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
    /// A `covers` prefix no registered repo has, or an entry without a
    /// prefix in a shared vault.
    Unlinked,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct StaleDoc {
    pub path: String,
    pub title: String,
    pub state: DocState,
    pub count: usize,
}

/// Another repo a `covers` prefix names; its entries are checked up to the
/// commit `base_ref` names in its primary checkout, not up to its `HEAD`.
#[derive(Debug, Clone)]
pub struct LinkedRepo {
    pub repo: Repo,
    pub base_ref: String,
}

/// The repos a vault's `covers` prefixes can name.
#[derive(Debug, Clone, Default)]
pub struct Links {
    /// The vault's own repo short name; entries with it read as unprefixed.
    pub own: Option<String>,
    /// A shared vault has no own repo, so unprefixed entries are unlinked.
    pub shared: bool,
    /// By short name. `None` is a registered repo that cannot be used, such
    /// as one whose folder is gone.
    pub repos: BTreeMap<String, Option<LinkedRepo>>,
}

/// Splits `name:rest` into a repo short name and the repo-relative rest,
/// without leading `./` or `/`. Anything else, such as a name with capitals
/// or an empty rest, is one unprefixed entry.
pub fn split_prefix(entry: &str) -> (Option<&str>, &str) {
    let Some((name, rest)) = entry.split_once(':') else {
        return (None, entry);
    };
    let mut bytes = name.bytes();
    let lead = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if !bytes.next().is_some_and(lead) || !bytes.all(|b| lead(b) || b".-_".contains(&b)) {
        return (None, entry);
    }
    let mut rest = rest;
    while let Some(r) = rest.strip_prefix("./").or_else(|| rest.strip_prefix('/')) {
        rest = r;
    }
    if rest.is_empty() {
        return (None, entry);
    }
    (Some(name), rest)
}

/// Reads the saved file, so the answer follows saves rather than commits.
pub fn freshness(
    vault: &Vault,
    repo: Option<&Repo>,
    links: &Links,
    path: &str,
) -> Result<Freshness, CoreError> {
    let content = vault.read(path)?;
    let (fm, _) = parse_frontmatter(&content);
    let groups = Groups::new(links, &fm.covers);
    let head = groups.head(repo, links)?;
    let (state, commits, count) = check(
        repo,
        links,
        &groups,
        fm.verified.as_deref(),
        FRESHNESS_COMMITS,
    )?;
    Ok(Freshness {
        state,
        covers: fm.covers,
        verified: fm.verified,
        head,
        commits,
        count,
    })
}

/// Docs whose state is stale, unverified, unlinked or unknown, sorted by
/// path. A doc that cannot be read is left out, as the index leaves it out.
pub fn stale_docs(
    vault: &Vault,
    repo: Option<&Repo>,
    links: &Links,
) -> Result<Vec<StaleDoc>, CoreError> {
    let mut out = Vec::new();
    for meta in vault.list()? {
        let Ok(content) = vault.read(&meta.path) else {
            continue;
        };
        let (fm, _) = parse_frontmatter(&content);
        if fm.covers.is_empty() {
            continue;
        }
        let groups = Groups::new(links, &fm.covers);
        let (state, _, count) = check(repo, links, &groups, fm.verified.as_deref(), 0)?;
        if !matches!(state, DocState::None | DocState::Fresh) {
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

/// A doc's `covers` sorted by the repo that answers for each entry.
struct Groups<'a> {
    /// Checked in the vault's own checkout up to its `HEAD`.
    own: Vec<String>,
    /// Registered prefixes in name order, with their repo-relative entries.
    others: BTreeMap<&'a str, Vec<String>>,
    /// Some entry no repo answers for.
    unlinked: bool,
    empty: bool,
}

impl<'a> Groups<'a> {
    fn new(links: &Links, covers: &'a [String]) -> Groups<'a> {
        let mut groups = Groups {
            own: Vec::new(),
            others: BTreeMap::new(),
            unlinked: false,
            empty: covers.is_empty(),
        };
        for entry in covers {
            match split_prefix(entry) {
                (None, rest) if !links.shared => groups.own.push(rest.to_owned()),
                (Some(name), rest) if links.own.as_deref() == Some(name) => {
                    groups.own.push(rest.to_owned());
                }
                (Some(name), rest) if links.repos.contains_key(name) => {
                    groups.others.entry(name).or_default().push(rest.to_owned());
                }
                _ => groups.unlinked = true,
            }
        }
        groups
    }

    /// The commit "Mark verified" writes: the own `HEAD` when only own
    /// entries are covered, the base-ref commit when only one other repo is,
    /// else none, since one `verified` cannot be right for two repos.
    fn head(&self, repo: Option<&Repo>, links: &Links) -> Result<Option<String>, CoreError> {
        let has_own = !self.own.is_empty();
        if self.others.is_empty() {
            if links.shared && !has_own {
                return Ok(None);
            }
            return Ok(match repo {
                Some(repo) => repo.head_id()?,
                None => None,
            });
        }
        if has_own || self.others.len() > 1 {
            return Ok(None);
        }
        let only = self.others.keys().next().and_then(|n| links.repos.get(*n));
        match only {
            Some(Some(linked)) => {
                Ok(tolerate(linked.repo.resolve_ref(&linked.base_ref))?.flatten())
            }
            _ => Ok(None),
        }
    }
}

/// The parts checked so far, merged.
#[derive(Default)]
struct Tally {
    commits: Vec<Commit>,
    count: usize,
    unknown: bool,
}

impl Tally {
    fn add(&mut self, part: Option<(Vec<Commit>, usize)>) {
        match part {
            Some((commits, count)) => {
                self.commits.extend(commits);
                self.count += count;
            }
            None => self.unknown = true,
        }
    }
}

fn check(
    repo: Option<&Repo>,
    links: &Links,
    groups: &Groups<'_>,
    verified: Option<&str>,
    limit: usize,
) -> Result<(DocState, Vec<Commit>, usize), CoreError> {
    if groups.empty {
        return Ok((DocState::None, Vec::new(), 0));
    }
    // Checked before git, so a doc nobody confirmed reads the same in CI and
    // outside a repo.
    let Some(verified) = verified else {
        return Ok((DocState::Unverified, Vec::new(), 0));
    };
    let mut tally = Tally::default();
    if !groups.own.is_empty() {
        tally.add(own_part(repo, &groups.own, verified, limit)?);
    }
    for (name, entries) in &groups.others {
        let left = limit.saturating_sub(tally.commits.len());
        let part = match links.repos.get(*name) {
            Some(Some(linked)) => linked_part(linked, entries, verified, left)?,
            _ => None,
        };
        tally.add(part);
    }
    let state = if tally.count > 0 {
        DocState::Stale
    } else if groups.unlinked {
        DocState::Unlinked
    } else if tally.unknown {
        DocState::Unknown
    } else {
        DocState::Fresh
    };
    Ok((state, tally.commits, tally.count))
}

/// `verified..HEAD` in the vault's own checkout; `None` is unknown.
fn own_part(
    repo: Option<&Repo>,
    entries: &[String],
    verified: &str,
    limit: usize,
) -> Result<Option<(Vec<Commit>, usize)>, CoreError> {
    let Some(repo) = repo else {
        return Ok(None);
    };
    let Some(since) = repo.resolve_commit(verified)? else {
        return Ok(None);
    };
    tolerate(repo.commits_since(&since, entries, limit))
}

/// `verified..<base-ref commit>` in another repo's primary checkout; `None`
/// is unknown.
fn linked_part(
    linked: &LinkedRepo,
    entries: &[String],
    verified: &str,
    limit: usize,
) -> Result<Option<(Vec<Commit>, usize)>, CoreError> {
    let Some(since) = tolerate(linked.repo.resolve_commit(verified))?.flatten() else {
        return Ok(None);
    };
    let Some(until) = tolerate(linked.repo.resolve_ref(&linked.base_ref))?.flatten() else {
        return Ok(None);
    };
    tolerate(linked.repo.commits_between(&since, &until, entries, limit))
}

/// A failure tied to this doc's range, covers or a repo's base ref must not
/// hide every other doc; one that means git is unusable still propagates.
fn tolerate<T>(result: Result<T, GitError>) -> Result<Option<T>, CoreError> {
    match result {
        Ok(found) => Ok(Some(found)),
        Err(GitError::Failed { .. } | GitError::BadId(_)) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
