use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};
use xdev_git::{BaseRefresh, GitError, Repo, WorktreeEntry};

use crate::hooks;
use crate::kept::{KeptBranch, KeptReason, keep};
use crate::registry::normalize;
use crate::staging;
use crate::vaults::{docs_dir_text, validate_docs_dir};
use crate::{
    Linked, MadeBy, Registry, RepoEntry, ScriptSource, SetupPolicy, WorkItem, WorkStatus,
    WorkspaceError, WorktreeMeta, link_shared, names, repo_id, unlink_shared,
};

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
    pub setup_policy: SetupPolicy,
    pub script_source: ScriptSource,
    /// This machine's scripts; the shared ones come from `repo_hooks`.
    pub local_setup: String,
    pub local_archive: String,
    /// The repo's docs folder, relative to the primary checkout; `docs` by
    /// default.
    pub docs_dir: String,
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
    /// The shown name; `None` shows `name`.
    pub title: Option<String>,
    pub comment: String,
    pub status: Option<WorkStatus>,
    /// The parent worktree's path, only while that worktree is shown for
    /// the same repo; otherwise the row is top-level.
    pub parent: Option<String>,
    pub item: Option<WorkItem>,
    pub made_by: MadeBy,
    /// On the repo's base branch (by its short name).
    pub default_branch: bool,
    /// The branch name was picked by the app and may still be renamed from
    /// the first prompt.
    pub auto_name: bool,
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

pub(crate) fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Every repo whose folder is still there.
pub(crate) fn find_repo_entries(reg: &Registry) -> Vec<RepoEntry> {
    reg.repos
        .iter()
        .filter(|r| r.path.is_dir())
        .cloned()
        .collect()
}

pub(crate) fn find_repo(reg: &Registry, id: &str) -> Result<RepoEntry, WorkspaceError> {
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
        ..RepoEntry::default()
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
    pub setup_policy: Option<SetupPolicy>,
    pub script_source: Option<ScriptSource>,
    pub local_setup: Option<String>,
    pub local_archive: Option<String>,
    /// A relative folder; `Some("")` goes back to the default `docs`.
    pub docs_dir: Option<String>,
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
    let docs_dir = patch
        .docs_dir
        .as_deref()
        .map(validate_docs_dir)
        .transpose()?;
    if let Some(dir) = &docs_dir {
        let target = old
            .path
            .join(dir.as_deref().unwrap_or(crate::vaults::DEFAULT_DOCS_DIR));
        let key = path_key(&target);
        if reg.vaults.iter().any(|v| path_key(&v.path) == key) {
            return Err(WorkspaceError::VaultExists(lossy(&target)));
        }
    }
    let entry = &mut reg.repos[idx];
    if let Some(dir) = docs_dir {
        entry.docs_dir = dir;
    }
    if let Some(name) = patch.short_name {
        entry.short_name = name;
    }
    if let Some(base) = patch.base_ref {
        entry.base_ref = base;
    }
    if let Some(root) = patch.worktree_root {
        entry.worktree_root = root;
    }
    if let Some(policy) = patch.setup_policy {
        entry.setup_policy = policy;
    }
    if let Some(source) = patch.script_source {
        entry.script_source = source;
    }
    if let Some(script) = patch.local_setup {
        entry.local_setup = script;
    }
    if let Some(script) = patch.local_archive {
        entry.local_archive = script;
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
    reg.kept.retain(|k| k.repo_id != id);
    crate::groups::forget_id(reg, id);
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
        setup_policy: entry.setup_policy,
        script_source: entry.script_source,
        local_setup: entry.local_setup.clone(),
        local_archive: entry.local_archive.clone(),
        docs_dir: docs_dir_text(entry),
        missing: true,
        worktrees: Vec::new(),
        found: Vec::new(),
    }
}

/// Where a worktree began: its fork point from the base, else its head.
pub(crate) fn start_of(
    repo: &Repo,
    entry: &WorktreeEntry,
    base_ref: &str,
) -> Result<String, WorkspaceError> {
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

/// The local branch name `base_ref` stands for: `main` for `main`,
/// `refs/heads/main`, or `origin/main` when no local branch has that whole
/// name. `None` when it names no branch, e.g. `HEAD`.
pub(crate) fn default_short(repo: &Repo, base_ref: &str) -> Result<Option<String>, WorkspaceError> {
    if let Some(name) = base_ref.strip_prefix("refs/heads/") {
        return Ok(Some(name.to_owned()));
    }
    if let Some(rest) = base_ref.strip_prefix("refs/remotes/") {
        return Ok(rest.split_once('/').map(|(_, b)| b.to_owned()));
    }
    if base_ref == "HEAD" || base_ref.is_empty() {
        return Ok(None);
    }
    match base_ref.split_once('/') {
        Some((_, rest)) if !repo.branch_exists(base_ref)? => Ok(Some(rest.to_owned())),
        _ => Ok(Some(base_ref.to_owned())),
    }
}

pub(crate) fn view_of(
    entry: &WorktreeEntry,
    short_name: &str,
    meta: Option<&WorktreeMeta>,
    default: Option<&str>,
) -> WorktreeView {
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
        title: meta.and_then(|m| m.title.clone()),
        comment: meta.map(|m| m.comment.clone()).unwrap_or_default(),
        status: meta.and_then(|m| m.status),
        parent: meta.and_then(|m| m.parent.as_deref()).map(lossy),
        item: meta.and_then(|m| m.item.clone()),
        made_by: meta.map(|m| m.made_by).unwrap_or_default(),
        default_branch: default.is_some() && entry.branch.as_deref() == default,
        auto_name: meta.is_some_and(|m| m.auto_name),
    }
}

/// A folder name without its `<short_name>-` prefix.
pub(crate) fn strip_prefix(folder: &str, short_name: &str) -> String {
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
    let default = default_short(&repo, &entry.base_ref)?;
    let default = default.as_deref();
    let linked: Vec<&WorktreeEntry> = listed.iter().skip(1).filter(|e| !e.bare).collect();
    // A prunable entry is still listed: its record stays, in case the
    // folder comes back, but it is not shown.
    let known: HashSet<String> = linked.iter().map(|e| path_key(&e.path)).collect();
    reg.worktrees
        .retain(|m| m.repo_id != entry.id || known.contains(&path_key(&m.path)));

    let live = || {
        linked
            .iter()
            .filter(|e| !e.prunable && !staging::in_staging(&e.path))
    };
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
                created_ms: now_ms,
                ..WorktreeMeta::default()
            });
        }
    }

    if let Some(primary) = listed.first() {
        view.worktrees
            .push(view_of(primary, &entry.short_name, None, default));
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
                view_of(wt, &entry.short_name, Some(meta), default),
            ))
        })
        .collect();
    rest.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    view.worktrees.extend(rest.into_iter().map(|(_, _, v)| v));
    // A parent that is not a shown linked worktree of this repo is ignored:
    // the child shows top-level.
    let shown: HashSet<String> = view
        .worktrees
        .iter()
        .filter(|w| !w.primary)
        .map(|w| path_key(Path::new(&w.path)))
        .collect();
    for wt in &mut view.worktrees {
        if wt
            .parent
            .as_deref()
            .is_some_and(|p| !shown.contains(&path_key(Path::new(p))))
        {
            wt.parent = None;
        }
    }
    view.found = live()
        .filter(|wt| !recorded(reg, wt))
        .map(|wt| {
            let mut found = view_of(wt, &entry.short_name, None, default);
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
            created_ms: now_ms,
            ..WorktreeMeta::default()
        };
        let default = default_short(&repo, &entry.base_ref)?;
        let view = view_of(wt, &entry.short_name, Some(&meta), default.as_deref());
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
    prefix: Option<&str>,
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
        if !repo.branch_exists(&prefixed(prefix, &word))? && !worktree_folder(entry, &word).exists()
        {
            return Ok(word);
        }
        taken.insert(word);
    }
}

/// The title a new worktree shows: what was typed, when a suffix kept the
/// branch from matching it or the text has an emoji the branch drops;
/// otherwise unset, and the row shows its folder name.
fn shown_title(typed: &str, suffixed: bool) -> Option<String> {
    let emoji = typed.chars().any(|c| {
        matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE0F | 0x200D)
    });
    (suffixed || emoji).then(|| typed.chars().take(TITLE_MAX).collect())
}

fn worktree_folder(entry: &RepoEntry, slug: &str) -> PathBuf {
    entry
        .worktree_root
        .join(format!("{}-{}", entry.short_name, slug.replace('/', "-")))
}

/// Where the first part of a new branch name comes from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum BranchPrefix {
    /// The repo's `user.name`; one no ref can hold is left out silently.
    GitUsername,
    /// Typed by the person; one no ref can hold is refused.
    Custom(String),
    #[default]
    None,
}

/// How `create_worktree_with` makes a worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateOptions {
    pub prefix: BranchPrefix,
    /// Recorded on the new worktree; the desktop app passes `App`.
    pub made_by: MadeBy,
    /// Paths of the main checkout to link into the new worktree; the caller
    /// passes the list only when the person trusted it.
    pub shared: Vec<String>,
    /// A name whose branch or folder is taken gets `-2`, `-3`, … instead of
    /// an error; the desktop app sets it, the CLI chooses.
    pub suffix: bool,
}

/// What a typed worktree name would become; see `name_preview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NamePreview {
    pub branch: String,
    /// The folder's name under the worktree root.
    pub folder: String,
    /// A suffix was added because the typed name is taken.
    pub suffixed: bool,
}

/// The branch and folder `name` (not blank) gets: the first of `leaf`,
/// `leaf-2`, … that is free when `opts.suffix`, else `leaf` or an error.
struct Named {
    branch: String,
    folder: PathBuf,
    /// A suffix was added.
    suffixed: bool,
}

fn name_typed(
    repo: &Repo,
    entry: &RepoEntry,
    prefix: Option<&str>,
    name: &str,
    suffix: bool,
) -> Result<Named, WorkspaceError> {
    let leaf = names::slug(name);
    let first = prefixed(prefix, &leaf);
    // Before `branch_exists`, which reads `main~1` as a branch that exists.
    if leaf.is_empty() || !repo.valid_branch_name(&first)? {
        return Err(WorkspaceError::BadName(name.to_owned()));
    }
    let tries = if suffix { names::SUFFIX_MAX } else { 1 };
    for n in 1..=tries {
        let leaf_n = names::suffixed(&leaf, n);
        let branch = prefixed(prefix, &leaf_n);
        let folder = worktree_folder(entry, &leaf_n);
        let branch_taken = repo.branch_exists(&branch)?;
        if !branch_taken && !folder.exists() {
            return Ok(Named {
                branch,
                folder,
                suffixed: n > 1,
            });
        }
        if !suffix {
            return Err(if branch_taken {
                WorkspaceError::BranchExists(branch)
            } else {
                WorkspaceError::WorktreeExists(folder)
            });
        }
    }
    Err(WorkspaceError::BranchExists(first))
}

/// What `create_worktree_with` would name the branch and folder for `name`,
/// without making anything. A blank `name` gets a random free word at
/// creation, so there is nothing to show: empty strings.
pub fn name_preview(
    reg: &Registry,
    repo_id: &str,
    name: &str,
    opts: &CreateOptions,
) -> Result<NamePreview, WorkspaceError> {
    let entry = find_repo(reg, repo_id)?;
    let repo = Repo::discover(&entry.path)?;
    let name = name.trim();
    if name.is_empty() {
        return Ok(NamePreview {
            branch: String::new(),
            folder: String::new(),
            suffixed: false,
        });
    }
    let prefix = branch_prefix(&repo, &opts.prefix)?;
    let named = name_typed(&repo, &entry, prefix.as_deref(), name, opts.suffix)?;
    Ok(NamePreview {
        branch: named.branch,
        folder: named
            .folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        suffixed: named.suffixed,
    })
}

/// Fetches the base a new worktree of `repo_id` would start from (`from`,
/// else the repo's base ref) and fast-forwards its local branch; see
/// `Repo::refresh_local_base`. It talks to the remote, so callers run it
/// before `create_worktree_with` and outside any registry lock.
pub fn refresh_base(
    reg: &Registry,
    repo_id: &str,
    from: Option<&str>,
) -> Result<BaseRefresh, WorkspaceError> {
    let entry = find_repo(reg, repo_id)?;
    let repo = Repo::discover(&entry.path)?;
    let base = from
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&entry.base_ref);
    Ok(repo.refresh_local_base(base)?)
}

/// The prefix to put in front of new branch names, normalized; `None` for
/// no prefix. `BadPrefix` only for a custom one.
fn branch_prefix(repo: &Repo, rule: &BranchPrefix) -> Result<Option<String>, WorkspaceError> {
    let (raw, custom) = match rule {
        BranchPrefix::None => return Ok(None),
        BranchPrefix::Custom(p) => (p.clone(), true),
        BranchPrefix::GitUsername => (repo.user_name()?.unwrap_or_default(), false),
    };
    let prefix = names::normalize_prefix(&raw);
    if prefix.is_empty() {
        return Ok(None);
    }
    match names::prefix_issue(&prefix) {
        None => Ok(Some(prefix)),
        Some(_) if custom => Err(WorkspaceError::BadPrefix(prefix)),
        Some(_) => Ok(None),
    }
}

fn prefixed(prefix: Option<&str>, leaf: &str) -> String {
    match prefix {
        Some(p) => format!("{p}/{leaf}"),
        None => leaf.to_owned(),
    }
}

/// `create_worktree_with` and no options: no prefix.
pub fn create_worktree(
    reg: &mut Registry,
    repo_id: &str,
    name: &str,
    from: Option<&str>,
    now_ms: i64,
    seed: u64,
) -> Result<WorktreeView, WorkspaceError> {
    create_worktree_with(
        reg,
        repo_id,
        name,
        from,
        now_ms,
        seed,
        &CreateOptions::default(),
    )
}

/// A new branch and a worktree for it under the repo's worktree root. A
/// blank `name` gets a free word; `from` defaults to the repo's base ref.
/// The branch is `<prefix>/<name>`; the folder is named from `name` alone.
pub fn create_worktree_with(
    reg: &mut Registry,
    repo_id: &str,
    name: &str,
    from: Option<&str>,
    now_ms: i64,
    seed: u64,
    opts: &CreateOptions,
) -> Result<WorktreeView, WorkspaceError> {
    create_worktree_linked(reg, repo_id, name, from, now_ms, seed, opts).map(|(view, _)| view)
}

/// `create_worktree_with`, and what linking `opts.shared` did. A link that
/// fails is reported, not fatal: the worktree is still made.
pub fn create_worktree_linked(
    reg: &mut Registry,
    repo_id: &str,
    name: &str,
    from: Option<&str>,
    now_ms: i64,
    seed: u64,
    opts: &CreateOptions,
) -> Result<(WorktreeView, Vec<Linked>), WorkspaceError> {
    let entry = find_repo(reg, repo_id)?;
    let repo = Repo::discover(&entry.path)?;
    let prefix = branch_prefix(&repo, &opts.prefix)?;
    let name = name.trim();
    let auto_name = name.is_empty();
    let (slug, folder, title) = if name.is_empty() {
        let leaf = pick_free(
            &repo,
            &entry,
            &repo.list_worktrees()?,
            prefix.as_deref(),
            seed,
        )?;
        let slug = prefixed(prefix.as_deref(), &leaf);
        if !repo.valid_branch_name(&slug)? {
            return Err(WorkspaceError::BadName(name.to_owned()));
        }
        (slug, worktree_folder(&entry, &leaf), None)
    } else {
        let named = name_typed(&repo, &entry, prefix.as_deref(), name, opts.suffix)?;
        let title = shown_title(name, named.suffixed);
        (named.branch, named.folder, title)
    };
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
    let git_entry = add_staged(&repo, &entry, &folder, &slug, &start, seed)?;
    let meta = WorktreeMeta {
        repo_id: entry.id.clone(),
        path: git_entry.path.clone(),
        start,
        created_ms: now_ms,
        made_here: true,
        made_by: opts.made_by,
        title,
        auto_name,
        ..WorktreeMeta::default()
    };
    let linked = link_shared(&entry.path, &git_entry.path, &opts.shared);
    let default = default_short(&repo, &entry.base_ref)?;
    let view = view_of(
        &git_entry,
        &entry.short_name,
        Some(&meta),
        default.as_deref(),
    );
    reg.worktrees.push(meta);
    Ok((view, linked))
}

/// Renames the branch of the worktree at `path` to `leaf` under the same
/// prefix, taking `-2`, `-3`, … when `leaf` is taken (`opts.suffix`). The
/// folder never moves: open terminals work in it. Refused with an upstream
/// (`BranchPushed`) or a detached `HEAD`. The shown title becomes the words
/// of the new name when it was unset, and the worktree is no longer
/// auto-named.
pub fn rename_branch(
    reg: &mut Registry,
    path: &Path,
    leaf: &str,
    opts: &CreateOptions,
) -> Result<WorktreeView, WorkspaceError> {
    let key = path_key(path);
    let Some(index) = reg.worktrees.iter().position(|m| path_key(&m.path) == key) else {
        return Err(if reg.repos.iter().any(|r| path_key(&r.path) == key) {
            WorkspaceError::Primary(path.to_owned())
        } else {
            WorkspaceError::WorktreeUnknown(path.to_owned())
        });
    };
    let entry = find_repo(reg, &reg.worktrees[index].repo_id)?;
    let repo = Repo::discover(path)?;
    let old = repo
        .current_branch()?
        .ok_or_else(|| WorkspaceError::Detached(path.to_owned()))?;
    if repo.upstream()?.is_some() {
        return Err(WorkspaceError::BranchPushed(old));
    }
    // The branch keeps whatever stands in front of its last `/`.
    let prefix = old.rsplit_once('/').map(|(p, _)| p);
    let leaf = names::slug(leaf);
    if leaf.is_empty() || !repo.valid_branch_name(&prefixed(prefix, &leaf))? {
        return Err(WorkspaceError::BadName(leaf));
    }
    let tries = if opts.suffix { names::SUFFIX_MAX } else { 1 };
    let mut chosen = None;
    for n in 1..=tries {
        let leaf_n = names::suffixed(&leaf, n);
        let branch = prefixed(prefix, &leaf_n);
        if branch == old {
            chosen = Some((leaf_n, false));
            break;
        }
        if !repo.branch_exists(&branch)? {
            chosen = Some((leaf_n, true));
            break;
        }
    }
    let Some((leaf, moves)) = chosen else {
        return Err(WorkspaceError::BranchExists(prefixed(prefix, &leaf)));
    };
    let new = prefixed(prefix, &leaf);
    if moves {
        repo.rename_branch(&old, &new)?;
    }
    let meta = &mut reg.worktrees[index];
    meta.auto_name = false;
    if meta.title.is_none() {
        let words: String = leaf.replace(['-', '_', '/'], " ");
        meta.title = Some(words.chars().take(TITLE_MAX).collect());
    }
    let meta = meta.clone();
    let git_entry = repo
        .list_worktrees()?
        .into_iter()
        .find(|e| path_key(&e.path) == key)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(path.to_owned()))?;
    let default = default_short(&repo, &entry.base_ref)?;
    Ok(view_of(
        &git_entry,
        &entry.short_name,
        Some(&meta),
        default.as_deref(),
    ))
}

/// How many times, and how far apart, the move out of staging is tried.
const MOVE_TRIES: u32 = 3;
const MOVE_GAP: Duration = Duration::from_millis(500);

static STAGING_RUNS: AtomicU64 = AtomicU64::new(0);

/// Makes the worktree in a staging folder and moves it to `folder` when git
/// is done, so a half-made one never sits under its real name. Any failure
/// takes the staging worktree and the new branch back. Returns git's entry
/// for the worktree at its final place.
fn add_staged(
    repo: &Repo,
    entry: &RepoEntry,
    folder: &Path,
    slug: &str,
    start: &str,
    seed: u64,
) -> Result<WorktreeEntry, WorkspaceError> {
    fs::create_dir_all(&entry.worktree_root)?;
    let nonce = seed ^ STAGING_RUNS.fetch_add(1, Ordering::Relaxed);
    let stage = staging::staging_dir(&entry.worktree_root, std::process::id(), nonce);
    let undo = |at: &Path| {
        let _ = repo.remove_fresh_worktree(at);
        let _ = repo.delete_branch(slug);
        if let Some(dir) = stage.parent() {
            // Only goes when no other run is staging in it.
            let _ = fs::remove_dir(dir);
        }
    };
    if let Some(dir) = stage.parent() {
        fs::create_dir_all(dir)?;
    }
    if let Err(e) = repo.add_worktree(&stage, slug, start) {
        undo(&stage);
        return Err(e.into());
    }
    if let Err(e) = move_out(repo, &stage, folder) {
        undo(&stage);
        return Err(e);
    }
    if let Some(dir) = stage.parent() {
        let _ = fs::remove_dir(dir);
    }
    // Kept in git's spelling of the path, which may differ from `folder`
    // when the root lies behind a link; `list` matches on it.
    let listed = repo.list_worktrees().inspect_err(|_| undo(folder))?;
    Ok(listed
        .into_iter()
        .find(|e| e.branch.as_deref() == Some(slug))
        .unwrap_or_else(|| WorktreeEntry {
            path: folder.to_owned(),
            head: Some(start.to_owned()),
            branch: Some(slug.to_owned()),
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
        }))
}

/// `git worktree move`, tried again when something holds the folder for a
/// moment (a scanner on Windows); a target that appeared is not retried.
fn move_out(repo: &Repo, stage: &Path, folder: &Path) -> Result<(), WorkspaceError> {
    for attempt in 1..=MOVE_TRIES {
        if folder.symlink_metadata().is_ok() {
            return Err(WorkspaceError::WorktreeExists(folder.to_owned()));
        }
        match repo.move_worktree(stage, folder) {
            Ok(()) => return Ok(()),
            Err(e) if attempt == MOVE_TRIES => return Err(e.into()),
            Err(_) => thread::sleep(MOVE_GAP),
        }
    }
    Ok(())
}

/// The branch tip is in the history of `base_ref`, so deleting the branch
/// loses no commit.
pub(crate) fn is_merged(repo: &Repo, branch: &str, base_ref: &str) -> Result<bool, WorkspaceError> {
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

/// Longest title, in chars.
pub const TITLE_MAX: usize = 120;
/// Longest comment, in chars.
pub const COMMENT_MAX: usize = 2000;
/// Longest work item link, in chars.
pub const ITEM_URL_MAX: usize = 2048;

/// Reads a present JSON value, `null` included, as `Some`, so an absent key
/// (`None` through `default`) and `null` (`Some(None)`) differ.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Edits to a worktree's details. An outer `None` (an absent key) leaves the
/// field as it is; `Some(None)` (`null`) clears it.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DetailsPatch {
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub title: Option<Option<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub comment: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub status: Option<Option<WorkStatus>>,
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub item: Option<Option<WorkItem>>,
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<Option<String>>"))]
    pub parent: Option<Option<PathBuf>>,
}

fn check_item(item: &WorkItem) -> Result<(), WorkspaceError> {
    let url = &item.url;
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    if rest.is_none_or(str::is_empty)
        || url.chars().count() > ITEM_URL_MAX
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(WorkspaceError::BadItem(url.clone()));
    }
    if item
        .title
        .as_ref()
        .is_some_and(|t| t.chars().count() > TITLE_MAX)
    {
        return Err(WorkspaceError::BadItem("title too long".to_owned()));
    }
    Ok(())
}

/// Whether `parent` may hold the worktree at `index`: a recorded linked
/// worktree of the same repo, not itself, with no parent of its own; and
/// the worktree has no children. One level only.
fn check_parent(reg: &Registry, index: usize, parent: &Path) -> Result<PathBuf, WorkspaceError> {
    let bad = || WorkspaceError::BadParent(lossy(parent));
    let me = &reg.worktrees[index];
    let key = path_key(parent);
    let my_key = path_key(&me.path);
    if key == my_key {
        return Err(bad());
    }
    let holder = reg
        .worktrees
        .iter()
        .find(|m| path_key(&m.path) == key)
        .ok_or_else(bad)?;
    if holder.repo_id != me.repo_id || holder.parent.is_some() {
        return Err(bad());
    }
    let has_children = reg
        .worktrees
        .iter()
        .any(|m| m.parent.as_deref().is_some_and(|p| path_key(p) == my_key));
    if has_children {
        return Err(bad());
    }
    // The registry's own spelling, so later lookups match.
    Ok(holder.path.clone())
}

/// Sets a linked worktree's title, comment, status, work item or parent.
/// Every field is checked before any is written. A blank title, or a blank
/// work item title, is cleared. Lengths count chars.
pub fn set_details(
    reg: &mut Registry,
    path: &Path,
    patch: DetailsPatch,
) -> Result<(), WorkspaceError> {
    let key = path_key(path);
    if reg.repos.iter().any(|r| path_key(&r.path) == key) {
        return Err(WorkspaceError::Primary(path.to_owned()));
    }
    let index = reg
        .worktrees
        .iter()
        .position(|m| path_key(&m.path) == key)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(path.to_owned()))?;
    let blank_none = |t: String| Some(t.trim().to_owned()).filter(|t| !t.is_empty());
    let title = patch.title.map(|t| t.and_then(blank_none));
    if let Some(Some(t)) = &title
        && t.chars().count() > TITLE_MAX
    {
        return Err(WorkspaceError::BadDetails("title".to_owned()));
    }
    if let Some(c) = &patch.comment
        && c.chars().count() > COMMENT_MAX
    {
        return Err(WorkspaceError::BadDetails("comment".to_owned()));
    }
    let item = patch.item.map(|i| {
        i.map(|i| WorkItem {
            url: i.url.trim().to_owned(),
            title: i.title.and_then(blank_none),
            kind: i.kind,
        })
    });
    if let Some(Some(i)) = &item {
        check_item(i)?;
    }
    let parent = match patch.parent {
        Some(Some(p)) => Some(Some(check_parent(reg, index, &p)?)),
        other => other,
    };
    let meta = &mut reg.worktrees[index];
    if let Some(t) = title {
        meta.title = t;
    }
    if let Some(c) = patch.comment {
        meta.comment = c;
    }
    if let Some(s) = patch.status {
        meta.status = s;
    }
    if let Some(i) = item {
        meta.item = i;
    }
    if let Some(p) = parent {
        meta.parent = p;
    }
    Ok(())
}

/// Children of the worktree whose path key is `key` become top-level.
pub(crate) fn orphan_children(reg: &mut Registry, key: &str) {
    for m in &mut reg.worktrees {
        if m.parent.as_deref().is_some_and(|p| path_key(p) == key) {
            m.parent = None;
        }
    }
}

/// A linked worktree about to lose its folder, after the shared checks.
pub(crate) struct Leaving {
    pub idx: usize,
    pub meta: WorktreeMeta,
    pub entry: RepoEntry,
    pub repo: Repo,
    pub key: String,
    /// Shared paths of its `xdev.toml`; links to take out before it goes.
    pub shared: Vec<String>,
    /// Its branch, unless git lists it detached or another worktree has
    /// the same branch checked out.
    pub branch: Option<String>,
}

/// Finds the linked worktree at `path` and, without `force`, refuses one
/// with changes, untracked files included.
pub(crate) fn leaving(reg: &Registry, path: &Path, force: bool) -> Result<Leaving, WorkspaceError> {
    let key = path_key(path);
    if reg.repos.iter().any(|r| path_key(&r.path) == key) {
        return Err(WorkspaceError::Primary(path.to_owned()));
    }
    let idx = reg
        .worktrees
        .iter()
        .position(|m| path_key(&m.path) == key)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(path.to_owned()))?;
    let meta = reg.worktrees[idx].clone();
    let entry = find_repo(reg, &meta.repo_id)?;
    let repo = Repo::discover(&entry.path)?;

    let shared = hooks::shared_list(&entry, &meta.path);
    // Plain `status` lists untracked files; `is_clean` does not. A shared
    // link shows as untracked unless the repo ignores it, so it does not count.
    if !force && meta.path.exists() {
        let status = Repo::discover(&meta.path)?.status()?;
        if status.iter().any(|f| !under_shared(&shared, &f.path)) {
            return Err(WorkspaceError::Dirty(path.to_owned()));
        }
    }
    let listed = repo.list_worktrees()?;
    let branch = listed
        .iter()
        .find(|e| path_key(&e.path) == key)
        .filter(|e| !e.detached)
        .and_then(|e| e.branch.clone())
        .filter(|b| {
            !listed
                .iter()
                .any(|e| path_key(&e.path) != key && e.branch.as_deref() == Some(b))
        });
    Ok(Leaving {
        idx,
        meta,
        entry,
        repo,
        key,
        shared,
        branch,
    })
}

/// `file` is a shared path or lies below one.
fn under_shared(shared: &[String], file: &str) -> bool {
    let file = file.trim_end_matches('/');
    shared.iter().any(|s| {
        file == s
            || file
                .strip_prefix(s.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Removes the folder through git and the record; children become
/// top-level. Never touches the branch.
pub(crate) fn drop_folder(reg: &mut Registry, l: &Leaving) -> Result<(), WorkspaceError> {
    // Before git removes the folder, so nothing can follow a link out of it.
    unlink_shared(&l.meta.path, &l.shared)?;
    l.repo.remove_worktree(&l.meta.path)?;
    reg.worktrees.remove(l.idx);
    orphan_children(reg, &l.key);
    Ok(())
}

/// What `remove_worktree` and `archive_worktree` did with the branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub deleted_branch: Option<String>,
    /// The branch left in git and added to the registry's kept list.
    pub kept: Option<KeptBranch>,
}

/// Removes a linked worktree. Without `force` it must have no changes,
/// untracked files included. Its branch goes too when this app made it and,
/// unless `force`, all its commits are in `base_ref`. A branch it leaves
/// (unmerged, or of an imported worktree) is listed in `kept` as `Deleted`.
pub fn remove_worktree(
    reg: &mut Registry,
    path: &Path,
    force: bool,
    now_ms: i64,
) -> Result<Removed, WorkspaceError> {
    let l = leaving(reg, path, force)?;
    // Without `force`, commits found nowhere else keep their branch.
    let delete = match &l.branch {
        Some(b) if l.meta.made_here => force || is_merged(&l.repo, b, &l.entry.base_ref)?,
        _ => false,
    };
    drop_folder(reg, &l)?;
    match l.branch.clone() {
        Some(branch) if delete => {
            l.repo.delete_branch(&branch)?;
            Ok(Removed {
                deleted_branch: Some(branch),
                kept: None,
            })
        }
        Some(branch) => {
            let kept = keep(reg, &l.meta, branch, KeptReason::Deleted, now_ms);
            Ok(Removed {
                deleted_branch: None,
                kept: Some(kept),
            })
        }
        None => Ok(Removed {
            deleted_branch: None,
            kept: None,
        }),
    }
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

/// A name Windows would not keep as typed: a trailing dot or space is dropped
/// (`.git.` opens `.git`), and `nul`, `con.txt`, `COM1` name devices.
fn windows_odd(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    if name.ends_with(['.', ' ']) {
        return true;
    }
    let stem = name.split('.').next().unwrap_or_default();
    let stem = stem.trim_end().to_ascii_lowercase();
    let numbered = |p: &str| {
        stem.strip_prefix(p)
            .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
    };
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt")
}

/// `rel` under `worktree`, when `rel` is plain (relative, no `..`, no drive
/// or stream) and no part of it is a link or `.git`. Every part must exist,
/// but the last one may be missing when `missing_last`; a missing folder
/// above it is `NotFound`.
fn under(worktree: &str, rel: &str, missing_last: bool) -> Result<PathBuf, WorkspaceError> {
    let bad = || WorkspaceError::BadPath(rel.to_owned());
    let plain = Path::new(rel)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    // `a:stream` would name a stream of the folder, not a path.
    if !plain || (cfg!(windows) && rel.contains(':')) {
        return Err(bad());
    }
    let names: Vec<_> = Path::new(rel)
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    // Every name first: a bad one is refused even under a missing folder.
    if names
        .iter()
        .any(|name| is_git(name) || (cfg!(windows) && windows_odd(name)))
    {
        return Err(bad());
    }
    let mut disk = PathBuf::from(worktree);
    for (i, name) in names.iter().enumerate() {
        let last = i + 1 == names.len();
        disk.push(name);
        let meta = match fs::symlink_metadata(&disk) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound && last && missing_last => break,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(WorkspaceError::NotFound(rel.to_owned()));
            }
            Err(e) => return Err(e.into()),
        };
        // A link is not followed: it could lead anywhere on the disk.
        if meta.is_symlink() || (!last && !meta.is_dir()) {
            return Err(bad());
        }
        // Windows also opens `.git` as `GIT~1`; the name on disk tells.
        if cfg!(windows) && fs::canonicalize(&disk)?.file_name().is_some_and(is_git) {
            return Err(bad());
        }
    }
    Ok(disk)
}

/// The folder `rel` names under `worktree` (`""` for its top); see `under`.
fn dir_under(worktree: &str, rel: &str) -> Result<PathBuf, WorkspaceError> {
    under(worktree, rel, false)
}

/// The file or folder `rel` names under `worktree`, for the editor: it need
/// not exist yet, but every folder above it must be a real folder (no link),
/// and `rel` must name something below the top.
pub(crate) fn rel_under(worktree: &str, rel: &str) -> Result<PathBuf, WorkspaceError> {
    let named = Path::new(rel)
        .components()
        .any(|c| matches!(c, Component::Normal(_)));
    if !named {
        return Err(WorkspaceError::BadPath(rel.to_owned()));
    }
    under(worktree, rel, true)
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

    #[test]
    fn rel_under_refuses_paths_that_leave_the_worktree() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join("a").join(".git")).unwrap();
        fs::write(tmp.path().join("file.txt"), "x").unwrap();
        let mut bad = vec![
            "",
            ".",
            "../x",
            "a/../../x",
            "a/..",
            "/etc/passwd",
            ".git/config",
            ".GIT",
            "a/.git",
            "a/.git/new",
        ];
        if cfg!(windows) {
            bad.extend([
                "C:x",
                r"C:\x",
                r"\\host\share\x",
                r"a\..\..\x",
                "a:stream",
                "x/.git.",
                "x/.git ",
                "new.",
                "nul",
                "a/CON.txt",
            ]);
        }
        for rel in bad {
            let err = rel_under(root, rel).unwrap_err();
            assert_eq!(err.code(), "bad_path", "{rel:?}");
        }
        // A file is not a folder to go into.
        assert_eq!(
            rel_under(root, "file.txt/x").unwrap_err().code(),
            "bad_path"
        );
    }

    #[test]
    fn rel_under_allows_a_missing_last_part_under_real_folders() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        fs::write(tmp.path().join("src").join("lib.rs"), "x").unwrap();
        assert_eq!(
            rel_under(root, "src/new.rs").unwrap(),
            tmp.path().join("src").join("new.rs")
        );
        assert_eq!(
            rel_under(root, "./src/lib.rs").unwrap(),
            tmp.path().join("src").join("lib.rs")
        );
        assert_eq!(rel_under(root, "new").unwrap(), tmp.path().join("new"));
        // Only the last part may be missing.
        assert_eq!(
            rel_under(root, "nope/new.rs").unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn rel_under_does_not_follow_symlinks() {
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
        for rel in ["link", "link/x.txt", "link/new.txt"] {
            assert_eq!(
                rel_under(root, rel).unwrap_err().code(),
                "bad_path",
                "{rel}"
            );
        }
    }

    #[test]
    fn list_dir_reports_a_missing_folder_as_not_found() {
        let tmp = TempDir::new().unwrap();
        let err = list_dir(tmp.path().to_str().unwrap(), "nope").unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    fn entry() -> RepoEntry {
        RepoEntry {
            id: "id".into(),
            short_name: "r".into(),
            path: "/r".into(),
            base_ref: "main".into(),
            worktree_root: "/wt".into(),
            ..RepoEntry::default()
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

    #[test]
    fn a_move_that_fails_leaves_no_branch_and_no_staging_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        fs::create_dir(&main).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .current_dir(&main)
                .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
            String::from_utf8(out.stdout).unwrap()
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "one"]);
        let start = git(&["rev-parse", "HEAD"]).trim().to_owned();
        let repo = Repo::discover(&main).unwrap();
        let entry = RepoEntry {
            id: "id".into(),
            short_name: "main".into(),
            path: main.clone(),
            base_ref: "HEAD".into(),
            worktree_root: tmp.path().join("wt"),
            ..RepoEntry::default()
        };
        // The folder appeared after the name was checked.
        let folder = worktree_folder(&entry, "late");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("x"), "x").unwrap();
        let err = add_staged(&repo, &entry, &folder, "late", &start, 1).unwrap_err();
        assert_eq!(err.code(), "worktree_exists");
        assert!(!repo.branch_exists("late").unwrap());
        assert_eq!(repo.list_worktrees().unwrap().len(), 1);
        assert!(!entry.worktree_root.join(staging::STAGING).exists());
        assert!(folder.join("x").exists());
    }
}
