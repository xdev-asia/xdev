use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

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
    /// The folder new worktrees of this repo go under.
    pub worktree_root: String,
    /// The folder is gone or no longer a repo; the entry stays so a
    /// reconnected drive finds it again.
    pub missing: bool,
    pub worktrees: Vec<WorktreeView>,
    /// Live linked worktrees git lists that xDev has no record of, sorted by
    /// path. They stay here until `adopt_worktree`.
    pub found: Vec<WorktreeView>,
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

/// Paths from git, the registry and the UI compare in this form: `/` as the
/// separator, no trailing `/`, lowercased on Windows. A canonical Windows path
/// (`\\?\E:\x`, `\\?\UNC\host\share`) reads as its plain spelling, so a vault
/// root from `canonicalize` matches the folder the person registered.
pub fn path_key(path: &Path) -> String {
    let text = normalize(path);
    let plain = if cfg!(windows) {
        if let Some(rest) = text.strip_prefix("//?/unc/") {
            format!("//{rest}")
        } else {
            text.strip_prefix("//?/")
                .map_or(text.clone(), str::to_owned)
        }
    } else {
        text
    };
    plain.trim_end_matches('/').to_owned()
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
    // The primary checkout in git's own spelling, whichever worktree or link
    // `dir` was reached through: this is the spelling `list` compares with.
    let root = Repo::discover(dir)?
        .list_worktrees()?
        .into_iter()
        .next()
        .map(|e| e.path)
        .ok_or(GitError::NoRepo)?;
    let repo = Repo::discover(&root)?;
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
    let view = sync_repo(reg, idx, now_ms, true);
    if view.is_err() {
        reg.repos.pop();
        reg.worktrees.truncate(before);
    }
    view
}

/// Edits to a repo's settings; a `None` field is left as it is.
#[derive(Debug, Default, Clone)]
pub struct RepoPatch {
    pub short_name: Option<String>,
    pub base_ref: Option<String>,
    pub worktree_root: Option<PathBuf>,
}

/// 1 to 40 characters: `[a-z0-9]` first, then `[a-z0-9._-]`. No `:` or `/`,
/// so a `<short_name>:` prefix is never ambiguous.
pub fn valid_short_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.len() <= 40
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '.' | '_' | '-'))
}

/// Changes a repo's short name, base ref or worktree folder. Every field is
/// checked before any is written, so a refusal leaves the repo as it was.
/// Existing worktrees are neither moved nor renamed.
pub fn update_repo(
    reg: &mut Registry,
    id: &str,
    patch: RepoPatch,
) -> Result<RepoView, WorkspaceError> {
    let idx = reg
        .repos
        .iter()
        .position(|r| r.id == id)
        .ok_or_else(|| WorkspaceError::RepoUnknown(id.to_owned()))?;
    let old = reg.repos[idx].clone();
    if let Some(name) = &patch.short_name {
        if !valid_short_name(name) {
            return Err(WorkspaceError::BadName(name.clone()));
        }
        if reg
            .repos
            .iter()
            .any(|r| r.id != id && &r.short_name == name)
        {
            return Err(WorkspaceError::ShortNameTaken(name.clone()));
        }
    }
    if let Some(base) = &patch.base_ref {
        let repo = Repo::discover(&old.path)?;
        match repo.resolve_ref(base) {
            Ok(Some(_)) => {}
            Ok(None) | Err(GitError::BadId(_)) => return Err(WorkspaceError::BadRef(base.clone())),
            Err(e) => return Err(e.into()),
        }
    }
    if let Some(root) = &patch.worktree_root {
        let key = path_key(root);
        let primary = path_key(&old.path);
        if !root.is_absolute() || key == primary || key.starts_with(&format!("{primary}/")) {
            return Err(WorkspaceError::BadPath(lossy(root)));
        }
    }
    let entry = &mut reg.repos[idx];
    if let Some(name) = patch.short_name {
        entry.short_name = name;
    }
    if let Some(base) = patch.base_ref {
        entry.base_ref = base;
    }
    if let Some(root) = patch.worktree_root {
        entry.worktree_root = root;
    }
    let worktrees = reg.worktrees.clone();
    let view = sync_repo(reg, idx, 0, false);
    if view.is_err() {
        reg.repos[idx] = old;
        reg.worktrees = worktrees;
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
/// Records of worktrees git no longer lists are dropped. A live worktree
/// without a record is not recorded: it comes back in `found` until
/// `adopt_worktree`.
pub fn list(reg: &mut Registry) -> Result<Vec<RepoView>, WorkspaceError> {
    (0..reg.repos.len())
        .map(|idx| {
            let entry = reg.repos[idx].clone();
            or_missing(sync_repo(reg, idx, 0, false), &entry)
        })
        .collect()
}

/// One repo git cannot read must not blank the whole sidebar: it shows as
/// missing. Only "no git program" is every repo's problem.
fn or_missing(
    result: Result<RepoView, WorkspaceError>,
    entry: &RepoEntry,
) -> Result<RepoView, WorkspaceError> {
    match result {
        Err(WorkspaceError::Git(GitError::NoGit)) => Err(GitError::NoGit.into()),
        Err(WorkspaceError::Git(_) | WorkspaceError::Io(_)) => Ok(missing_view(entry)),
        other => other,
    }
}

fn missing_view(entry: &RepoEntry) -> RepoView {
    RepoView {
        id: entry.id.clone(),
        short_name: entry.short_name.clone(),
        path: lossy(&entry.path),
        base_ref: entry.base_ref.clone(),
        worktree_root: lossy(&entry.worktree_root),
        missing: true,
        worktrees: Vec::new(),
        found: Vec::new(),
    }
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

/// Aligns one repo's records with git's list and returns its view. With
/// `import`, a live worktree without a record gets one (`add_repo`); without
/// it, such a worktree is only reported in `found`.
fn sync_repo(
    reg: &mut Registry,
    idx: usize,
    now_ms: i64,
    import: bool,
) -> Result<RepoView, WorkspaceError> {
    let entry = reg.repos[idx].clone();
    let mut view = missing_view(&entry);
    if !entry.path.is_dir() {
        return Ok(view);
    }
    let repo = match Repo::discover(&entry.path) {
        Ok(repo) => repo,
        Err(GitError::NoRepo) => return Ok(view),
        Err(e) => return Err(e.into()),
    };

    let listed = repo.list_worktrees()?;
    // A folder that now sits inside another repo is not this repo, and must
    // not take that repo's worktrees as its own.
    if listed
        .first()
        .is_none_or(|primary| path_key(&primary.path) != path_key(&entry.path))
    {
        return Ok(view);
    }
    view.missing = false;
    let linked: Vec<&WorktreeEntry> = listed.iter().skip(1).filter(|e| !e.bare).collect();
    // A prunable entry is still listed: its record stays, in case the
    // folder comes back, but it is not shown.
    let known: HashSet<String> = linked.iter().map(|e| path_key(&e.path)).collect();
    reg.worktrees
        .retain(|m| m.repo_id != entry.id || known.contains(&path_key(&m.path)));

    let live = || linked.iter().filter(|e| !e.prunable);
    let recorded = |reg: &Registry, wt: &WorktreeEntry| {
        let key = path_key(&wt.path);
        reg.worktrees
            .iter()
            .any(|m| m.repo_id == entry.id && path_key(&m.path) == key)
    };
    if import {
        for wt in live() {
            if recorded(reg, wt) {
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
    view.found = live()
        .filter(|wt| !recorded(reg, wt))
        .map(|wt| {
            let mut found = view_of(wt, &entry.short_name, None);
            // `view_of` reads "no record" as the primary checkout.
            found.primary = false;
            found
        })
        .collect();
    view.found.sort_by_key(|w| path_key(Path::new(&w.path)));
    Ok(view)
}

/// Records a linked worktree xDev found outside itself, as one it did not
/// make: removing it later keeps its branch. `WorktreeExists` when it is
/// already recorded, `Primary` for a primary checkout, `WorktreeUnknown` when
/// no registered repo lists it.
pub fn adopt_worktree(
    reg: &mut Registry,
    path: &Path,
    now_ms: i64,
) -> Result<WorktreeView, WorkspaceError> {
    let key = path_key(path);
    if reg.repos.iter().any(|r| path_key(&r.path) == key) {
        return Err(WorkspaceError::Primary(path.to_owned()));
    }
    if reg.worktrees.iter().any(|m| path_key(&m.path) == key) {
        return Err(WorkspaceError::WorktreeExists(path.to_owned()));
    }
    for entry in reg.repos.clone() {
        if !entry.path.is_dir() {
            continue;
        }
        let repo = match Repo::discover(&entry.path) {
            Ok(repo) => repo,
            Err(GitError::NoRepo) => continue,
            Err(e) => return Err(e.into()),
        };
        let listed = repo.list_worktrees()?;
        // Not this repo when its folder now sits inside another one.
        if listed
            .first()
            .is_none_or(|primary| path_key(&primary.path) != path_key(&entry.path))
        {
            continue;
        }
        let Some(wt) = listed
            .iter()
            .skip(1)
            .find(|e| !e.bare && !e.prunable && path_key(&e.path) == key)
        else {
            continue;
        };
        let meta = WorktreeMeta {
            repo_id: entry.id.clone(),
            path: wt.path.clone(),
            start: start_of(&repo, wt, &entry.base_ref)?,
            pinned: false,
            created_ms: now_ms,
            made_here: false,
        };
        let view = view_of(wt, &entry.short_name, Some(&meta));
        reg.worktrees.push(meta);
        return Ok(view);
    }
    Err(WorkspaceError::WorktreeUnknown(path.to_owned()))
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
    // Kept in git's spelling of the path, which may differ from `folder`
    // when the root lies behind a link; `list` matches on it.
    let git_entry = repo
        .list_worktrees()?
        .into_iter()
        .find(|e| e.branch.as_deref() == Some(slug.as_str()))
        .unwrap_or_else(|| WorktreeEntry {
            path: folder,
            head: Some(start.clone()),
            branch: Some(slug),
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
        });
    let meta = WorktreeMeta {
        repo_id: entry.id.clone(),
        path: git_entry.path.clone(),
        start,
        pinned: false,
        created_ms: now_ms,
        made_here: true,
    };
    let view = view_of(&git_entry, &entry.short_name, Some(&meta));
    reg.worktrees.push(meta);
    Ok(view)
}

/// The branch tip is in the history of `base_ref`, so deleting the branch
/// loses no commit.
fn is_merged(repo: &Repo, branch: &str, base_ref: &str) -> Result<bool, WorkspaceError> {
    let full = format!("refs/heads/{branch}");
    let Some(tip) = repo.resolve_ref(&full)? else {
        return Ok(false);
    };
    Ok(repo.merge_base(&full, base_ref)? == Some(tip))
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
/// untracked files included. Its branch goes too when this app made it and,
/// unless `force`, all its commits are in `base_ref`; the branch of an
/// imported worktree is kept.
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
    // Without `force`, commits found nowhere else keep their branch.
    let branch = match branch {
        Some(b) if !force && !is_merged(&repo, &b, &entry.base_ref)? => None,
        other => other,
    };

    repo.remove_worktree(&meta.path)?;
    reg.worktrees.remove(meta_idx);
    if let Some(branch) = branch {
        repo.delete_branch(&branch)?;
    }
    Ok(())
}

/// What a worktree changed against where it started, for its sidebar row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStat {
    pub files: u32,
    pub added: u32,
    pub removed: u32,
}

/// Untracked files bigger than this are counted as a file, not by line.
const MAX_STAT_BYTES: u64 = 1 << 20;
/// Git's own look for binary: a NUL in the first 8 KiB.
const SNIFF_BYTES: usize = 8 << 10;

/// Lines of an untracked file; 0 for a link, a binary or a huge file.
fn lines_of(file: &Path) -> u32 {
    let Ok(meta) = fs::symlink_metadata(file) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > MAX_STAT_BYTES {
        return 0;
    }
    let Ok(bytes) = fs::read(file) else {
        return 0;
    };
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return 0;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count();
    let open_line = bytes.last().is_some_and(|b| *b != b'\n');
    u32::try_from(newlines + usize::from(open_line)).unwrap_or(u32::MAX)
}

/// Files and lines that differ from the worktree's start commit (`HEAD` for
/// the primary checkout): committed since, staged, unstaged, and untracked
/// files counted as added lines. A folder the registry does not know is
/// `WorktreeUnknown`.
pub fn stat(reg: &Registry, path: &Path) -> Result<WorktreeStat, WorkspaceError> {
    let key = path_key(path);
    // The registry decides first, so a folder it does not know is never read.
    let start = reg
        .worktrees
        .iter()
        .find(|m| path_key(&m.path) == key)
        .map(|m| m.start.clone());
    if start.is_none() && !reg.repos.iter().any(|r| path_key(&r.path) == key) {
        return Err(WorkspaceError::WorktreeUnknown(path.to_owned()));
    }
    let repo = Repo::discover(path)?;
    let base = match start {
        Some(start) => Some(start),
        None => repo.head_id()?,
    };
    let mut files = 0u32;
    let mut added = 0u32;
    let mut removed = 0u32;
    if let Some(base) = base {
        for line in repo.numstat_since(&base)? {
            files = files.saturating_add(1);
            added =
                added.saturating_add(u32::try_from(line.added.unwrap_or(0)).unwrap_or(u32::MAX));
            removed = removed
                .saturating_add(u32::try_from(line.removed.unwrap_or(0)).unwrap_or(u32::MAX));
        }
    }
    let top = repo.root();
    for file in repo.untracked()? {
        files = files.saturating_add(1);
        added = added.saturating_add(lines_of(&top.join(&file)));
    }
    Ok(WorktreeStat {
        files,
        added,
        removed,
    })
}

/// The most entries one folder listing carries.
const MAX_ENTRIES: usize = 2000;

/// One name in a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// A real folder; a link is a file here, whatever it points at.
    pub dir: bool,
}

/// One level of a worktree's files: folders first, then files, each A to Z
/// ignoring case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    /// The folder held more than 2000 names; the rest are not sent.
    pub truncated: bool,
}

fn is_git(name: &std::ffi::OsStr) -> bool {
    name.eq_ignore_ascii_case(".git")
}

/// The folder `rel` names under `worktree`, when `rel` is plain (relative,
/// no `..`, no drive or stream) and no part of it is a link or `.git`.
fn dir_under(worktree: &str, rel: &str) -> Result<PathBuf, WorkspaceError> {
    let bad = || WorkspaceError::BadPath(rel.to_owned());
    let plain = Path::new(rel)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    // `a:stream` would name a stream of the folder, not a path.
    if !plain || (cfg!(windows) && rel.contains(':')) {
        return Err(bad());
    }
    let mut disk = PathBuf::from(worktree);
    for part in Path::new(rel).components() {
        let Component::Normal(name) = part else {
            continue;
        };
        if is_git(name) {
            return Err(bad());
        }
        disk.push(name);
        // A link is not followed: it could lead anywhere on the disk.
        if fs::symlink_metadata(&disk)?.is_symlink() {
            return Err(bad());
        }
        // Windows also opens `.git` as `.git.`, `.git ` or `GIT~1`; the name
        // on disk tells.
        if cfg!(windows) && fs::canonicalize(&disk)?.file_name().is_some_and(is_git) {
            return Err(bad());
        }
    }
    Ok(disk)
}

/// The names in folder `rel` of `worktree` (`""` for its top). `.git` is left
/// out and links are listed as files, never followed. A folder with more than
/// 2000 names is cut after the first 2000 in order, with `truncated` set.
pub fn list_dir(worktree: &str, rel: &str) -> Result<DirListing, WorkspaceError> {
    let disk = dir_under(worktree, rel)?;
    let mut entries = Vec::new();
    for found in fs::read_dir(&disk)? {
        let found = found?;
        let name = found.file_name();
        if is_git(&name) {
            continue;
        }
        // The type of the entry itself: a link reads as a link, not as its target.
        let dir = found.file_type()?.is_dir();
        entries.push(DirEntry {
            name: name.to_string_lossy().into_owned(),
            dir,
        });
    }
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(DirListing { entries, truncated })
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;

    fn names(l: &DirListing) -> Vec<(&str, bool)> {
        l.entries.iter().map(|e| (e.name.as_str(), e.dir)).collect()
    }

    #[test]
    #[cfg(windows)]
    fn path_key_reads_a_canonical_windows_path_as_its_plain_spelling() {
        let plain = path_key(Path::new(r"E:\Codes\Notes\"));
        assert_eq!(plain, "e:/codes/notes");
        assert_eq!(path_key(Path::new(r"\\?\E:\Codes\Notes")), plain);
        assert_eq!(
            path_key(Path::new(r"\\?\UNC\host\share\x")),
            path_key(Path::new(r"\\host\share\x"))
        );
    }

    #[test]
    fn list_dir_sorts_folders_first_and_hides_git() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for dir in [".git", "src", "Docs", "alpha"] {
            fs::create_dir(root.join(dir)).unwrap();
        }
        for file in ["b.txt", "A.md", "Zed.rs", "c.txt", ".gitignore"] {
            fs::write(root.join(file), "x").unwrap();
        }
        fs::write(root.join("src").join("m.rs"), "x").unwrap();
        let top = list_dir(root.to_str().unwrap(), "").unwrap();
        assert_eq!(
            names(&top),
            [
                ("alpha", true),
                ("Docs", true),
                ("src", true),
                (".gitignore", false),
                ("A.md", false),
                ("b.txt", false),
                ("c.txt", false),
                ("Zed.rs", false),
            ]
        );
        assert!(!top.truncated);
        let sub = list_dir(root.to_str().unwrap(), "src").unwrap();
        assert_eq!(names(&sub), [("m.rs", false)]);
        assert_eq!(list_dir(root.to_str().unwrap(), ".").unwrap(), top);
    }

    #[test]
    fn list_dir_refuses_parent_and_absolute_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();
        fs::create_dir(tmp.path().join("a")).unwrap();
        let mut bad = vec![
            "..",
            "../x",
            "/x",
            "a/../..",
            ".git",
            "a/../.git",
            ".GIT/hooks",
        ];
        if cfg!(windows) {
            bad.extend(["C:\\x", "C:x", "..\\x", "a:stream"]);
        }
        for rel in bad {
            let err = list_dir(root, rel).unwrap_err();
            assert_eq!(err.code(), "bad_path", "{rel}");
        }
    }

    /// Windows opens `.git.`, `.git ` and the short name `GIT~1` as `.git`.
    #[cfg(windows)]
    #[test]
    fn list_dir_refuses_other_spellings_of_git_on_windows() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".git").join("hooks")).unwrap();
        fs::write(tmp.path().join(".git").join("config"), "").unwrap();
        let mut bad = vec![".git.", ".git ", ".git./hooks", ".GIT. /hooks"];
        // Short names exist only where the volume keeps them.
        if fs::symlink_metadata(tmp.path().join("GIT~1")).is_ok() {
            bad.extend(["GIT~1", "git~1/hooks"]);
        }
        for rel in bad {
            let err = list_dir(root, rel).unwrap_err();
            assert_eq!(err.code(), "bad_path", "{rel:?}");
        }
        // A plain folder with a tilde or dot in its name still lists.
        fs::create_dir(tmp.path().join("a~b.c")).unwrap();
        assert!(list_dir(root, "a~b.c").is_ok());
    }

    #[test]
    fn list_dir_caps_at_2000_and_flags_truncated() {
        let tmp = TempDir::new().unwrap();
        for n in 0..2005 {
            fs::write(tmp.path().join(format!("f{n:04}.txt")), "").unwrap();
        }
        let l = list_dir(tmp.path().to_str().unwrap(), "").unwrap();
        assert_eq!(l.entries.len(), 2000);
        assert!(l.truncated);
        assert_eq!(l.entries[0].name, "f0000.txt");
        let exact = TempDir::new().unwrap();
        for n in 0..2000 {
            fs::write(exact.path().join(format!("f{n:04}.txt")), "").unwrap();
        }
        let l = list_dir(exact.path().to_str().unwrap(), "").unwrap();
        assert_eq!((l.entries.len(), l.truncated), (2000, false));
    }

    /// Makes a folder link `link` to `target`; false when the system would not.
    fn link_dir(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        let made = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        made
    }

    #[test]
    fn list_dir_does_not_follow_symlinks() {
        let tmp = TempDir::new().unwrap();
        let outside = tmp.path().join("outside");
        let root = tmp.path().join("wt");
        fs::create_dir(&outside).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(outside.join("x.txt"), "secret").unwrap();
        if !link_dir(&root.join("link"), &outside) {
            eprintln!("skipped: cannot make a folder link here");
            return;
        }
        let root = root.to_str().unwrap();
        let top = list_dir(root, "").unwrap();
        assert_eq!(names(&top), [("link", false)]);
        assert_eq!(list_dir(root, "link").unwrap_err().code(), "bad_path");
        assert_eq!(list_dir(root, "link/sub").unwrap_err().code(), "bad_path");
    }

    fn entry() -> RepoEntry {
        RepoEntry {
            id: "id".into(),
            short_name: "r".into(),
            path: "/r".into(),
            base_ref: "main".into(),
            worktree_root: "/wt".into(),
        }
    }

    fn failed() -> WorkspaceError {
        GitError::Failed {
            args: "worktree list".into(),
            status: Some(128),
            stderr: "broken".into(),
        }
        .into()
    }

    #[test]
    fn one_broken_repo_shows_as_missing() {
        let view = or_missing(Err(failed()), &entry()).unwrap();
        assert!(view.missing && view.worktrees.is_empty());
        let io = std::io::Error::other("disk").into();
        assert!(or_missing(Err(io), &entry()).unwrap().missing);
    }

    #[test]
    fn no_git_stays_an_error() {
        let err = or_missing(Err(GitError::NoGit.into()), &entry()).unwrap_err();
        assert_eq!(err.code(), "no_git");
    }
}
