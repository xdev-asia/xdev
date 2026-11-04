//! The sidebar's shape: the order of top-level items, named groups of
//! repos and folders, and plain folders that are not git repos. Only
//! registry records change here; nothing on disk is touched.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::kept::{KeptView, kept_list};
use crate::ops::{RepoView, list, path_key};
use crate::{Registry, WorkspaceError, repo_id};

/// A named set of repos and folders shown together in the sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RepoGroup {
    pub id: String,
    pub name: String,
    /// Repo and folder ids, in shown order.
    #[serde(default)]
    pub members: Vec<String>,
}

/// A folder that is not a repo, listed so it can be opened and browsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// The 12-hex path hash `repo_id` makes.
    pub id: String,
    #[cfg_attr(feature = "ts", ts(as = "String"))]
    pub path: PathBuf,
    pub name: String,
}

/// One row of the sidebar, in shown order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
// One item per sidebar entry, built once per list call: the size gap costs nothing.
#[allow(clippy::large_enum_variant)]
pub enum SidebarItem {
    /// A repo with its kept branches (archived or left by a delete).
    Repo {
        repo: RepoView,
        kept: Vec<KeptView>,
    },
    Folder {
        folder: FolderEntry,
    },
    Group {
        group: RepoGroup,
        items: Vec<SidebarItem>,
    },
}

fn grouped(reg: &Registry, id: &str) -> bool {
    reg.groups.iter().any(|g| g.members.iter().any(|m| m == id))
}

fn is_member(reg: &Registry, id: &str) -> bool {
    reg.repos.iter().any(|r| r.id == id) || reg.folders.iter().any(|f| f.id == id)
}

/// The top-level ids in shown order: `order` first, then whatever it
/// misses in the order it was added (repos, folders, groups). Members of a
/// group are not top-level.
fn top_ids(reg: &Registry) -> Vec<String> {
    let top = |id: &str| {
        (is_member(reg, id) && !grouped(reg, id)) || reg.groups.iter().any(|g| g.id == id)
    };
    let mut ids: Vec<String> = Vec::new();
    let mut push = |id: &str| {
        if top(id) && !ids.iter().any(|i| i == id) {
            ids.push(id.to_owned());
        }
    };
    for id in &reg.order {
        push(id);
    }
    for r in &reg.repos {
        push(&r.id);
    }
    for f in &reg.folders {
        push(&f.id);
    }
    for g in &reg.groups {
        push(&g.id);
    }
    ids
}

fn group_index(reg: &Registry, id: &str) -> Result<usize, WorkspaceError> {
    reg.groups
        .iter()
        .position(|g| g.id == id)
        .ok_or_else(|| WorkspaceError::GroupUnknown(id.to_owned()))
}

/// Sets the top-level order. Unknown ids are skipped; items left out keep
/// their place after the listed ones.
pub fn set_order(reg: &mut Registry, ids: &[String]) -> Result<(), WorkspaceError> {
    reg.order = ids.to_vec();
    reg.order = top_ids(reg);
    Ok(())
}

/// Creates a group named `name` (no `id`) or renames the group `id`.
/// Returns the group's id.
pub fn group_put(
    reg: &mut Registry,
    id: Option<&str>,
    name: &str,
) -> Result<String, WorkspaceError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(WorkspaceError::BadName(name.to_owned()));
    }
    if let Some(id) = id {
        let idx = group_index(reg, id)?;
        reg.groups[idx].name = name.to_owned();
        return Ok(id.to_owned());
    }
    let id = (0u32..)
        .map(|n| repo_id(Path::new(&format!("group:{name}:{n}"))))
        .find(|id| !is_member(reg, id) && !reg.groups.iter().any(|g| &g.id == id))
        .expect("some id is free");
    reg.order = top_ids(reg);
    reg.order.push(id.clone());
    reg.groups.push(RepoGroup {
        id: id.clone(),
        name: name.to_owned(),
        members: Vec::new(),
    });
    Ok(id)
}

/// Removes the group; its members take its place at the top level.
pub fn group_remove(reg: &mut Registry, id: &str) -> Result<(), WorkspaceError> {
    let idx = group_index(reg, id)?;
    let mut order = top_ids(reg);
    let group = reg.groups.remove(idx);
    let at = order.iter().position(|i| i == id).unwrap_or(order.len());
    order.splice(at..(at + 1).min(order.len()), group.members);
    reg.order = order;
    reg.order = top_ids(reg);
    Ok(())
}

/// Moves a repo or folder into `group` at `index`, or to the top level at
/// `index` when `group` is `None`. An index past the end appends.
pub fn group_move(
    reg: &mut Registry,
    member: &str,
    group: Option<&str>,
    index: usize,
) -> Result<(), WorkspaceError> {
    if !is_member(reg, member) {
        return Err(WorkspaceError::RepoUnknown(member.to_owned()));
    }
    let target = group.map(|g| group_index(reg, g)).transpose()?;
    let mut order = top_ids(reg);
    order.retain(|i| i != member);
    for g in &mut reg.groups {
        g.members.retain(|m| m != member);
    }
    match target {
        Some(idx) => {
            let members = &mut reg.groups[idx].members;
            members.insert(index.min(members.len()), member.to_owned());
        }
        None => order.insert(index.min(order.len()), member.to_owned()),
    }
    reg.order = order;
    reg.order = top_ids(reg);
    Ok(())
}

/// Lists a plain folder in the sidebar. A repo, a worktree xDev knows or a
/// folder already listed is refused.
pub fn folder_add(reg: &mut Registry, path: &Path) -> Result<FolderEntry, WorkspaceError> {
    if !path.is_dir() {
        return Err(WorkspaceError::NotFound(path.display().to_string()));
    }
    let key = path_key(path);
    let taken = reg.repos.iter().any(|r| path_key(&r.path) == key)
        || reg.worktrees.iter().any(|m| path_key(&m.path) == key)
        || reg.folders.iter().any(|f| path_key(&f.path) == key);
    if taken {
        return Err(WorkspaceError::FolderExists(path.display().to_string()));
    }
    let folder = FolderEntry {
        id: repo_id(path),
        path: path.to_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
    };
    reg.order = top_ids(reg);
    reg.order.push(folder.id.clone());
    reg.folders.push(folder.clone());
    Ok(folder)
}

/// Drops the folder from the sidebar. Nothing on disk is touched.
pub fn folder_forget(reg: &mut Registry, id: &str) -> Result<(), WorkspaceError> {
    if !reg.folders.iter().any(|f| f.id == id) {
        return Err(WorkspaceError::FolderUnknown(id.to_owned()));
    }
    reg.folders.retain(|f| f.id != id);
    forget_id(reg, id);
    Ok(())
}

/// Drops `id` from every group and from the order.
pub(crate) fn forget_id(reg: &mut Registry, id: &str) {
    for g in &mut reg.groups {
        g.members.retain(|m| m != id);
    }
    reg.order.retain(|i| i != id);
}

/// The whole sidebar: repos (with kept branches), folders and groups in
/// shown order.
pub fn sidebar(reg: &mut Registry, now_ms: i64) -> Result<Vec<SidebarItem>, WorkspaceError> {
    let repos = list(reg)?;
    let kept = kept_list(reg, now_ms)?;
    let item = |id: &str| -> Option<SidebarItem> {
        if let Some(repo) = repos.iter().find(|r| r.id == id) {
            return Some(SidebarItem::Repo {
                repo: repo.clone(),
                kept: kept
                    .iter()
                    .filter(|k| k.entry.repo_id == id)
                    .cloned()
                    .collect(),
            });
        }
        reg.folders
            .iter()
            .find(|f| f.id == id)
            .map(|f| SidebarItem::Folder { folder: f.clone() })
    };
    Ok(top_ids(reg)
        .iter()
        .filter_map(|id| match reg.groups.iter().find(|g| &g.id == id) {
            Some(g) => Some(SidebarItem::Group {
                group: g.clone(),
                items: g.members.iter().filter_map(|m| item(m)).collect(),
            }),
            None => item(id),
        })
        .collect())
}
