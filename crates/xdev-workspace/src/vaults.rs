use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ops::path_key;
use crate::{Registry, RepoEntry, VaultEntry, WorkspaceError, repo_id};

/// Where a vault comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum VaultKind {
    /// The `docs/` folder of a registered repo's primary checkout.
    Repo,
    /// A folder the person added by hand.
    Shared,
}

/// A docs vault as the sidebar and the Vaults settings show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    /// `repo:<repo id>` for a repo vault, the path hash for a shared one.
    pub id: String,
    pub kind: VaultKind,
    pub path: String,
    /// The repo's short name, or the folder name of a shared vault.
    pub name: String,
    pub repo_id: Option<String>,
    /// The folder is there. A repo without `docs/` or a shared folder that
    /// is gone lists as not existing.
    pub exists: bool,
}

const DEFAULT_DOCS_DIR: &str = "docs";

/// The repo's docs folder as a relative path, `docs` when none is set.
pub(crate) fn docs_dir_text(entry: &RepoEntry) -> String {
    entry
        .docs_dir
        .clone()
        .unwrap_or_else(|| DEFAULT_DOCS_DIR.to_owned())
}

/// The folder a repo's own vault lives in.
pub fn repo_docs_dir(entry: &RepoEntry) -> PathBuf {
    entry.path.join(docs_dir_text(entry))
}

/// Checks a docs folder typed by the person. Returns `None` for an empty
/// string (back to the default), else the folder with `/` separators and no
/// `.` parts. A `..` part, a root, a drive or a UNC prefix is refused, in
/// either separator, whatever the host OS.
pub fn validate_docs_dir(s: &str) -> Result<Option<String>, WorkspaceError> {
    let text = s.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let bad = || WorkspaceError::BadPath(text.to_owned());
    let unified = text.replace('\\', "/");
    let drive = unified.as_bytes();
    if unified.starts_with('/')
        || (drive.len() >= 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':')
    {
        return Err(bad());
    }
    let mut parts = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(bad()),
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(bad());
    }
    Ok(Some(parts.join("/")))
}

fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| lossy(path))
}

fn shared_view(entry: &VaultEntry) -> VaultView {
    VaultView {
        id: entry.id.clone(),
        kind: VaultKind::Shared,
        path: lossy(&entry.path),
        name: folder_name(&entry.path),
        repo_id: None,
        exists: entry.path.is_dir(),
    }
}

/// Repo vaults in registry order, then shared vaults by name. Reads the
/// file system only, never git.
pub fn list_vaults(reg: &Registry) -> Vec<VaultView> {
    let mut views: Vec<VaultView> = reg
        .repos
        .iter()
        .map(|repo| {
            let docs = repo_docs_dir(repo);
            VaultView {
                id: format!("repo:{}", repo.id),
                kind: VaultKind::Repo,
                exists: docs.is_dir(),
                path: lossy(&docs),
                name: repo.short_name.clone(),
                repo_id: Some(repo.id.clone()),
            }
        })
        .collect();
    let mut shared: Vec<VaultView> = reg.vaults.iter().map(shared_view).collect();
    shared.sort_by_cached_key(|v| (v.name.to_lowercase(), path_key(Path::new(&v.path))));
    views.extend(shared);
    views
}

/// Records a folder as a shared vault. The folder must exist, and must not be
/// a shared vault or a repo's `docs/` already.
pub fn add_vault(reg: &mut Registry, path: &Path) -> Result<VaultView, WorkspaceError> {
    if !path.is_dir() {
        return Err(WorkspaceError::BadPath(lossy(path)));
    }
    let key = path_key(path);
    let taken = reg.vaults.iter().any(|v| path_key(&v.path) == key)
        || reg.repos.iter().any(|r| path_key(&repo_docs_dir(r)) == key);
    if taken {
        return Err(WorkspaceError::VaultExists(lossy(path)));
    }
    let entry = VaultEntry {
        id: repo_id(path),
        path: path.to_owned(),
    };
    let view = shared_view(&entry);
    reg.vaults.push(entry);
    Ok(view)
}

/// Drops the record of a shared vault; the folder stays. A repo vault is
/// derived, so it cannot be forgotten this way.
pub fn forget_vault(reg: &mut Registry, id: &str) -> Result<(), WorkspaceError> {
    let idx = reg
        .vaults
        .iter()
        .position(|v| v.id == id)
        .ok_or_else(|| WorkspaceError::VaultUnknown(id.to_owned()))?;
    reg.vaults.remove(idx);
    Ok(())
}

/// Adopts the folder the old single `last_vault` setting held as a shared
/// vault. Nothing happens for `None`, an empty path, a path already
/// registered or a repo's docs folder. The folder need not exist: a vault on
/// a drive that is away lists as not existing. Returns whether the registry
/// changed, so running it again returns `false`.
pub fn adopt_last_vault(reg: &mut Registry, last: Option<&Path>) -> bool {
    let Some(path) = last.filter(|p| !p.as_os_str().is_empty()) else {
        return false;
    };
    let key = path_key(path);
    let known = reg.vaults.iter().any(|v| path_key(&v.path) == key)
        || reg.repos.iter().any(|r| path_key(&repo_docs_dir(r)) == key);
    if known {
        return false;
    }
    reg.vaults.push(VaultEntry {
        id: repo_id(path),
        path: path.to_owned(),
    });
    true
}
