use std::collections::HashMap;
use std::path::{Component, Path};

use xdev_git::{ChangeKind, Commit, Repo};
use xdev_vault::{Vault, VaultError, content_hash, is_doc_path};

use crate::CoreError;

/// Who last changed a pending file. Kept in memory only, so after a restart
/// every pending change is `Outside`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    App,
    Outside,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
    pub origin: Origin,
}

/// Path to the content hash of xDev's last write to it.
pub type Written = HashMap<String, String>;

/// Every doc under the vault that differs from `HEAD`, sorted by path.
pub fn list_changes(
    vault: &Vault,
    repo: &Repo,
    written: &Written,
) -> Result<Vec<Change>, CoreError> {
    Ok(repo
        .status()?
        .into_iter()
        .filter(|s| is_doc_path(&s.path))
        .map(|s| {
            let app = s.kind != ChangeKind::Deleted
                && written
                    .get(&s.path)
                    .is_some_and(|hash| disk_hash(vault, &s.path).as_ref() == Some(hash));
            Change {
                origin: if app { Origin::App } else { Origin::Outside },
                path: s.path,
                kind: s.kind,
            }
        })
        .collect())
}

/// Commits the given docs and returns the new commit id, or `None` when none
/// of them is pending. An empty or blank message gets a default one.
pub fn approve(
    vault: &Vault,
    repo: &Repo,
    written: &Written,
    paths: &[String],
    message: &str,
) -> Result<Option<String>, CoreError> {
    let selected = pending_among(vault, repo, written, paths)?;
    if selected.is_empty() {
        return Ok(None);
    }
    let message = if message.trim().is_empty() {
        default_message(&selected)
    } else {
        message.to_owned()
    };
    let paths: Vec<String> = selected.into_iter().map(|c| c.path).collect();
    Ok(repo.commit(&paths, &message)?)
}

/// Puts the given docs back to `HEAD`; a doc not in `HEAD` is deleted.
pub fn reject(
    vault: &Vault,
    repo: &Repo,
    written: &Written,
    paths: &[String],
) -> Result<(), CoreError> {
    let (added, tracked): (Vec<Change>, Vec<Change>) = pending_among(vault, repo, written, paths)?
        .into_iter()
        .partition(|c| c.kind == ChangeKind::Added);
    repo.restore(&tracked.into_iter().map(|c| c.path).collect::<Vec<_>>())?;
    let added: Vec<String> = added.into_iter().map(|c| c.path).collect();
    // Out of the index first, so a staged copy does not outlive the file.
    repo.unstage(&added)?;
    for path in &added {
        vault.remove(path)?;
    }
    Ok(())
}

/// The doc as of `HEAD`; `None` when it is not in `HEAD`.
pub fn read_base(repo: &Repo, path: &str) -> Result<Option<String>, CoreError> {
    check_doc(path)?;
    to_text(path, repo.head_content(path)?)
}

/// The doc as of commit `id`; `None` when it did not exist then.
pub fn read_version(repo: &Repo, path: &str, id: &str) -> Result<Option<String>, CoreError> {
    check_doc(path)?;
    to_text(path, repo.show(id, path)?)
}

/// Commits that touched the doc, newest first.
pub fn history(repo: &Repo, path: &str, limit: usize) -> Result<Vec<Commit>, CoreError> {
    check_doc(path)?;
    Ok(repo.log(path, limit)?)
}

/// English on purpose: history is shared with other people and tools.
pub fn default_message(changes: &[Change]) -> String {
    match changes {
        [one] => {
            let verb = match one.kind {
                ChangeKind::Added => "Add",
                ChangeKind::Modified => "Update",
                ChangeKind::Deleted => "Delete",
            };
            format!("{verb} {}", one.path)
        }
        _ => format!("Update {} docs", changes.len()),
    }
}

/// Only paths that are pending right now: a stale UI list or a crafted call
/// must not commit or delete anything else.
fn pending_among(
    vault: &Vault,
    repo: &Repo,
    written: &Written,
    paths: &[String],
) -> Result<Vec<Change>, CoreError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    Ok(list_changes(vault, repo, written)?
        .into_iter()
        .filter(|c| paths.contains(&c.path))
        .collect())
}

/// A file that cannot be read now cannot match xDev's last write.
fn disk_hash(vault: &Vault, path: &str) -> Option<String> {
    let bytes = std::fs::read(vault.resolve(path).ok()?).ok()?;
    Some(content_hash(&bytes))
}

/// Git would read any path in the repo; these reads stay on vault docs.
fn check_doc(path: &str) -> Result<(), VaultError> {
    let plain = Path::new(path)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if plain && is_doc_path(path) {
        Ok(())
    } else {
        Err(VaultError::OutsideVault(path.to_owned()))
    }
}

fn to_text(path: &str, bytes: Option<Vec<u8>>) -> Result<Option<String>, CoreError> {
    bytes
        .map(|b| String::from_utf8(b).map_err(|_| VaultError::NotUtf8(path.to_owned()).into()))
        .transpose()
}
