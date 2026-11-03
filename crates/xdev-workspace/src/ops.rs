use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use xdev_git::{GitError, Repo, WorktreeEntry};

use crate::registry::normalize;
use crate::{Registry, RepoEntry, WorkspaceError, WorktreeMeta, names, repo_id};

/// A repo as the sidebar shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    pub id: String,
    pub short_name: String,
    pub path: String,
    pub base_ref: String,
    /// The folder is gone or no longer a repo; the entry stays so a
    /// reconnected drive finds it again.
    pub missing: bool,
    pub worktrees: Vec<WorktreeView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeView {
    pub path: String,
    /// The folder name without the `<short_name>-` prefix.
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// `None` for the primary checkout.
    pub start: Option<String>,
    pub primary: bool,
    pub pinned: bool,
    pub detached: bool,
}

/// Paths from git and from the registry compare in this form.
fn path_key(path: &Path) -> String {
    normalize(path).trim_end_matches('/').to_owned()
}

fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn find_repo(reg: &Registry, id: &str) -> Result<RepoEntry, WorkspaceError> {
    reg.repos
        .iter()
        .find(|r| r.id == id)
        .cloned()
        .ok_or_else(|| WorkspaceError::RepoUnknown(id.to_owned()))
}

/// `short_name` made from a folder name: lowercase, `[a-z0-9._-]` only.
fn short_name_of(root: &Path) -> String {
    let name: String = root
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if matches!(c, 'a'..='z' | '0'..='9' | '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if name.is_empty() {
        "repo".to_owned()
    } else {
        name
    }
}

/// Starts tracking the repo that contains `dir`, with every linked worktree
/// git already lists for it.
pub fn add_repo(reg: &mut Registry, dir: &Path, now_ms: i64) -> Result<RepoView, WorkspaceError> {
    let repo = Repo::discover(dir)?;
    // `components` drops a trailing `.` and a doubled separator, so two
    // spellings of one folder get one id.
    let root: PathBuf = repo.root().components().collect();
    let id = repo_id(&root);
    if reg.repos.iter().any(|r| r.id == id) {
        return Err(WorkspaceError::RepoExists(id));
    }
    let base = short_name_of(&root);
    let short_name = std::iter::once(base.clone())
        .chain((2..).map(|n| format!("{base}-{n}")))
        .find(|name| reg.repos.iter().all(|r| &r.short_name != name))
        .unwrap_or(base);
    let base_ref = repo.default_branch()?.unwrap_or_else(|| "HEAD".to_owned());
    let worktree_root = root.parent().unwrap_or(&root).join("wt");
    reg.repos.push(RepoEntry {
        id,
        short_name,
        path: root,
        base_ref,
        worktree_root,
    });
    let idx = reg.repos.len() - 1;
    let before = reg.worktrees.len();
    let view = sync_repo(reg, idx, now_ms);
    if view.is_err() {
        reg.repos.pop();
        reg.worktrees.truncate(before);
    }
    view
}

/// Drops the repo and what the registry knows about its worktrees. Nothing
/// on disk is touched.
pub fn forget_repo(reg: &mut Registry, id: &str) -> Result<(), WorkspaceError> {
    find_repo(reg, id)?;
    reg.repos.retain(|r| r.id != id);
    reg.worktrees.retain(|m| m.repo_id != id);
    Ok(())
}

/// Every repo with its worktrees, brought in line with what git lists now.
/// Worktrees found without a record get one, dated 0 as the app cannot know
/// when they were made.
pub fn list(reg: &mut Registry) -> Result<Vec<RepoView>, WorkspaceError> {
    (0..reg.repos.len())
        .map(|idx| sync_repo(reg, idx, 0))
        .collect()
}

/// Where a worktree began: its fork point from the base, else its head.
fn start_of(repo: &Repo, entry: &WorktreeEntry, base_ref: &str) -> Result<String, WorkspaceError> {
    // The id first: a branch and a tag may share a name.
    let tip = entry.head.as_deref().or(entry.branch.as_deref());
    let found = match tip {
        Some(tip) => match repo.merge_base(tip, base_ref) {
            Ok(found) => found,
            Err(GitError::BadId(_)) => None,
            Err(e) => return Err(e.into()),
        },
        None => None,
    };
    Ok(found.or_else(|| entry.head.clone()).unwrap_or_default())
}

fn view_of(entry: &WorktreeEntry, short_name: &str, meta: Option<&WorktreeMeta>) -> WorktreeView {
    let folder = entry
        .path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    WorktreeView {
        path: lossy(&entry.path),
        name: strip_prefix(&folder, short_name),
        branch: entry.branch.clone(),
        head: entry.head.clone(),
        start: meta
            .map(|m| m.start.clone())
            .filter(|start| !start.is_empty()),
        primary: meta.is_none(),
        pinned: meta.is_some_and(|m| m.pinned),
        detached: entry.detached,
    }
}

/// A folder name without its `<short_name>-` prefix.
fn strip_prefix(folder: &str, short_name: &str) -> String {
    match folder.strip_prefix(&format!("{short_name}-")) {
        Some(rest) if !rest.is_empty() => rest.to_owned(),
        _ => folder.to_owned(),
    }
}

/// Aligns one repo's records with git's list and returns its view.
fn sync_repo(reg: &mut Registry, idx: usize, now_ms: i64) -> Result<RepoView, WorkspaceError> {
    let entry = reg.repos[idx].clone();
    let mut view = RepoView {
        id: entry.id.clone(),
        short_name: entry.short_name.clone(),
        path: lossy(&entry.path),
        base_ref: entry.base_ref.clone(),
        missing: true,
        worktrees: Vec::new(),
    };
    if !entry.path.is_dir() {
        return Ok(view);
    }
    let repo = match Repo::discover(&entry.path) {
        Ok(repo) => repo,
        Err(GitError::NoRepo) => return Ok(view),
        Err(e) => return Err(e.into()),
    };
    view.missing = false;

    let listed = repo.list_worktrees()?;
    let linked: Vec<&WorktreeEntry> = listed.iter().skip(1).filter(|e| !e.bare).collect();
    // A prunable entry is still listed: its record stays, in case the
    // folder comes back, but it is not shown.
    let known: HashSet<String> = linked.iter().map(|e| path_key(&e.path)).collect();
    reg.worktrees
        .retain(|m| m.repo_id != entry.id || known.contains(&path_key(&m.path)));

    let live = || linked.iter().filter(|e| !e.prunable);
    for wt in live() {
        let key = path_key(&wt.path);
        if reg
            .worktrees
            .iter()
            .any(|m| m.repo_id == entry.id && path_key(&m.path) == key)
        {
            continue;
        }
        let start = start_of(&repo, wt, &entry.base_ref)?;
        reg.worktrees.push(WorktreeMeta {
            repo_id: entry.id.clone(),
            path: wt.path.clone(),
            start,
            pinned: false,
            created_ms: now_ms,
            made_here: false,
        });
    }

    if let Some(primary) = listed.first() {
        view.worktrees
            .push(view_of(primary, &entry.short_name, None));
    }
    let mut rest: Vec<(bool, i64, WorktreeView)> = live()
        .filter_map(|wt| {
            let key = path_key(&wt.path);
            let meta = reg
                .worktrees
                .iter()
                .find(|m| m.repo_id == entry.id && path_key(&m.path) == key)?;
            Some((
                meta.pinned,
                meta.created_ms,
                view_of(wt, &entry.short_name, Some(meta)),
            ))
        })
        .collect();
    rest.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    view.worktrees.extend(rest.into_iter().map(|(_, _, v)| v));
    Ok(view)
}

/// A word for a worktree nobody named: free as a branch, as a folder and
/// among the names already listed.
fn pick_free(
    repo: &Repo,
    entry: &RepoEntry,
    listed: &[WorktreeEntry],
    seed: u64,
) -> Result<String, WorkspaceError> {
    let mut taken: HashSet<String> = listed
        .iter()
        .filter_map(|e| e.branch.clone())
        .chain(listed.iter().filter_map(|e| {
            let folder = e.path.file_name()?.to_string_lossy().into_owned();
            Some(strip_prefix(&folder, &entry.short_name))
        }))
        .collect();
    loop {
        let word = names::pick(&taken, seed);
        if !repo.branch_exists(&word)? && !worktree_folder(entry, &word).exists() {
            return Ok(word);
        }
        taken.insert(word);
    }
}

fn worktree_folder(entry: &RepoEntry, slug: &str) -> PathBuf {
    entry
        .worktree_root
        .join(format!("{}-{}", entry.short_name, slug.replace('/', "-")))
}

/// A new branch and a worktree for it under the repo's worktree root. A
/// blank `name` gets a free word; `from` defaults to the repo's base ref.
pub fn create_worktree(
    reg: &mut Registry,
    repo_id: &str,
    name: &str,
    from: Option<&str>,
    now_ms: i64,
    seed: u64,
) -> Result<WorktreeView, WorkspaceError> {
    let entry = find_repo(reg, repo_id)?;
    let repo = Repo::discover(&entry.path)?;
    let name = name.trim();
    let slug = if name.is_empty() {
        pick_free(&repo, &entry, &repo.list_worktrees()?, seed)?
    } else {
        names::slug(name)
    };
    // Before `branch_exists`, which reads `main~1` as a branch that exists.
    if slug.is_empty() || !repo.valid_branch_name(&slug)? {
        return Err(WorkspaceError::BadName(name.to_owned()));
    }
    if repo.branch_exists(&slug)? {
        return Err(WorkspaceError::BranchExists(slug));
    }
    let folder = worktree_folder(&entry, &slug);
    if folder.exists() {
        return Err(WorkspaceError::WorktreeExists(folder));
    }
    let from = from
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&entry.base_ref);
    let start = match repo.resolve_ref(from) {
        Ok(Some(id)) => id,
        Ok(None) | Err(GitError::BadId(_)) => {
            return Err(WorkspaceError::BadRef(from.to_owned()));
        }
        Err(e) => return Err(e.into()),
    };
    fs::create_dir_all(&entry.worktree_root)?;
    repo.add_worktree(&folder, &slug, &start)?;
    let meta = WorktreeMeta {
        repo_id: entry.id.clone(),
        path: folder.clone(),
        start,
        pinned: false,
        created_ms: now_ms,
        made_here: true,
    };
    // Shown the way `list` shows it, in git's spelling of the path.
    let key = path_key(&folder);
    let git_entry = repo
        .list_worktrees()?
        .into_iter()
        .find(|e| path_key(&e.path) == key)
        .unwrap_or_else(|| WorktreeEntry {
            path: folder,
            head: Some(meta.start.clone()),
            branch: Some(slug),
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
        });
    let view = view_of(&git_entry, &entry.short_name, Some(&meta));
    reg.worktrees.push(meta);
    Ok(view)
}

pub fn set_pinned(reg: &mut Registry, path: &Path, pinned: bool) -> Result<(), WorkspaceError> {
    let key = path_key(path);
    let meta = reg
        .worktrees
        .iter_mut()
        .find(|m| path_key(&m.path) == key)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(path.to_owned()))?;
    meta.pinned = pinned;
    Ok(())
}

/// Removes a linked worktree. Without `force` it must have no changes,
/// untracked files included. Its branch goes too when this app made it; the
/// branch of an imported worktree is kept.
pub fn remove_worktree(reg: &mut Registry, path: &Path, force: bool) -> Result<(), WorkspaceError> {
    let key = path_key(path);
    if reg.repos.iter().any(|r| path_key(&r.path) == key) {
        return Err(WorkspaceError::Primary(path.to_owned()));
    }
    let meta_idx = reg
        .worktrees
        .iter()
        .position(|m| path_key(&m.path) == key)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(path.to_owned()))?;
    let meta = reg.worktrees[meta_idx].clone();
    let entry = find_repo(reg, &meta.repo_id)?;
    let repo = Repo::discover(&entry.path)?;

    // Plain `status` lists untracked files; `is_clean` does not.
    if !force && meta.path.exists() && !Repo::discover(&meta.path)?.status()?.is_empty() {
        return Err(WorkspaceError::Dirty(path.to_owned()));
    }
    let listed = repo.list_worktrees()?;
    let branch = listed
        .iter()
        .find(|e| path_key(&e.path) == key)
        .and_then(|e| e.branch.clone())
        .filter(|b| {
            meta.made_here
                && !listed
                    .iter()
                    .any(|e| path_key(&e.path) != key && e.branch.as_deref() == Some(b))
        });

    repo.remove_worktree(&meta.path)?;
    reg.worktrees.remove(meta_idx);
    if let Some(branch) = branch {
        repo.delete_branch(&branch)?;
    }
    Ok(())
}
