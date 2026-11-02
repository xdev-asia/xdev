use std::collections::HashMap;
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

use xdev_git::{ChangeKind, Commit, Repo};
use xdev_store::{AiWrite, Store};
use xdev_vault::{Vault, VaultError, content_hash, is_doc_path};

use crate::{CoreError, sync_vault};

/// Who last changed a pending file. `App` is kept in memory only, so after a
/// restart the app's own edits are `Outside`; `Ai` rows live in the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    App,
    Outside,
    Ai,
}

/// `note` is the agent's summary, only for `Ai`. `hash` is the content on
/// disk, `None` for a deletion.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
    pub origin: Origin,
    pub note: Option<String>,
    pub hash: Option<String>,
}

/// A pending change as the person last saw it, from `Change`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Seen {
    pub path: String,
    pub hash: Option<String>,
}

/// Path to the content hash of xDev's last write to it.
pub type Written = HashMap<String, String>;

/// The index's agent proposals, by path.
pub type AiWrites = HashMap<String, AiWrite>;

pub fn ai_writes(store: &Store) -> Result<AiWrites, CoreError> {
    Ok(store
        .ai_writes()?
        .into_iter()
        .map(|w| (w.path.clone(), w))
        .collect())
}

/// Every doc under the vault that differs from `HEAD`, sorted by path.
pub fn list_changes(
    vault: &Vault,
    repo: &Repo,
    written: &Written,
    ai: &AiWrites,
) -> Result<Vec<Change>, CoreError> {
    Ok(repo
        .status()?
        .into_iter()
        .filter(|s| is_doc_path(&s.path))
        .map(|s| {
            // A deleted file has nothing to compare, whoever wrote it last.
            let disk = (s.kind != ChangeKind::Deleted)
                .then(|| disk_hash(vault, &s.path))
                .flatten();
            let matches = |hash: &String| disk.as_ref() == Some(hash);
            // The app's write wins: a person saved that text in xDev, even
            // when an agent proposed the same.
            let (origin, note) = if written.get(&s.path).is_some_and(matches) {
                (Origin::App, None)
            } else if let Some(w) = ai.get(&s.path).filter(|w| matches(&w.hash)) {
                (Origin::Ai, w.note.clone())
            } else {
                (Origin::Outside, None)
            };
            Change {
                path: s.path,
                kind: s.kind,
                origin,
                note,
                hash: disk,
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
    ai: &AiWrites,
    seen: &[Seen],
    message: &str,
) -> Result<Option<String>, CoreError> {
    let selected = pending_among(vault, repo, written, ai, seen)?;
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
    ai: &AiWrites,
    seen: &[Seen],
) -> Result<(), CoreError> {
    let (added, tracked): (Vec<Change>, Vec<Change>) =
        pending_among(vault, repo, written, ai, seen)?
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

/// Drops the snapshot's rows for `paths` (same path and hash only), so a
/// proposal made after the snapshot stays pending as `ai`.
pub fn forget_ai_writes(
    store: &mut Store,
    ai: &AiWrites,
    paths: &[String],
) -> Result<(), CoreError> {
    let rows: Vec<(String, String)> = paths
        .iter()
        .filter_map(|p| ai.get(p))
        .map(|w| (w.path.clone(), w.hash.clone()))
        .collect();
    Ok(store.clear_ai_writes(&rows)?)
}

/// Writes an agent's version of a doc and records it as an `ai` change; only
/// a person's approval puts it in history. Refused with `Conflict` when the
/// doc has pending edits that are not the agent's own last proposal.
pub fn propose_update(
    vault: &Vault,
    repo: &Repo,
    store: &mut Store,
    path: &str,
    content: &str,
    summary: Option<&str>,
) -> Result<(), CoreError> {
    check_doc(path)?;
    let full = vault.resolve(path)?;
    // The key the review list uses: `./a.md` is `a.md`, and a file that
    // exists goes by its name on disk, whatever case or link reached it.
    let path = full
        .strip_prefix(vault.root())
        .ok()
        .and_then(|rel| {
            rel.components()
                .map(|c| c.as_os_str().to_str())
                .collect::<Option<Vec<_>>>()
        })
        .map(|parts| parts.join("/"))
        .ok_or_else(|| VaultError::OutsideVault(path.to_owned()))?;
    check_doc(&path)?;

    // Folders on Windows and macOS ignore case, so a new `A.md` may be the
    // person's pending deletion of `a.md`.
    let lower = path.to_lowercase();
    let pending = repo
        .status()?
        .iter()
        .any(|s| s.path.to_lowercase() == lower);
    let before = read_if_exists(&full);
    // Git's status alone is not enough: `--skip-worktree` or
    // `--assume-unchanged` hide a person's edit from it.
    let clean = !pending && same_text(&before, &repo.head_content(&path)?);
    if !clean && !is_own_proposal(vault, store, &path)? {
        return Err(CoreError::Conflict);
    }
    // Narrows the window for an edit saved while git ran; the app is another
    // process, so there is no lock to share.
    if read_if_exists(&full) != before {
        return Err(CoreError::Conflict);
    }

    vault.write(&path, content)?;
    store.record_ai_write(&AiWrite {
        hash: content_hash(content.as_bytes()),
        note: summary.filter(|s| !s.trim().is_empty()).map(str::to_owned),
        time_ms: now_ms(),
        path,
    })?;
    sync_vault(vault, store)?;
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
/// must not commit or delete anything else. A doc whose text changed since
/// the person saw it (an agent proposing again, an editor saving) fails the
/// whole call with `Changed`: its new text was never reviewed.
fn pending_among(
    vault: &Vault,
    repo: &Repo,
    written: &Written,
    ai: &AiWrites,
    seen: &[Seen],
) -> Result<Vec<Change>, CoreError> {
    if seen.is_empty() {
        return Ok(Vec::new());
    }
    let mut picked = Vec::new();
    for change in list_changes(vault, repo, written, ai)? {
        let Some(s) = seen.iter().find(|s| s.path == change.path) else {
            continue;
        };
        if s.hash != change.hash {
            return Err(CoreError::Changed);
        }
        picked.push(change);
    }
    Ok(picked)
}

/// `None` when absent; `Some(None)` when present but unreadable, which never
/// counts as clean.
fn read_if_exists(full: &Path) -> Option<Option<Vec<u8>>> {
    full.exists().then(|| std::fs::read(full).ok())
}

/// Line endings aside, so a checkout with `core.autocrlf` is still clean.
fn same_text(disk: &Option<Option<Vec<u8>>>, head: &Option<Vec<u8>>) -> bool {
    match (disk, head) {
        (None, None) => true,
        (Some(Some(d)), Some(h)) => d == h || crlf_to_lf(d) == crlf_to_lf(h),
        _ => false,
    }
}

fn crlf_to_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        if !(b == b'\r' && bytes.get(i + 1) == Some(&b'\n')) {
            out.push(b);
        }
    }
    out
}

fn is_own_proposal(vault: &Vault, store: &Store, path: &str) -> Result<bool, CoreError> {
    let row = store.ai_writes()?.into_iter().find(|w| w.path == path);
    Ok(row.is_some_and(|w| disk_hash(vault, path) == Some(w.hash)))
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn to_text(path: &str, bytes: Option<Vec<u8>>) -> Result<Option<String>, CoreError> {
    bytes
        .map(|b| String::from_utf8(b).map_err(|_| VaultError::NotUtf8(path.to_owned()).into()))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::same_text;

    #[test]
    fn same_text_ignores_line_endings_only() {
        let disk = |b: &[u8]| Some(Some(b.to_vec()));
        assert!(same_text(&disk(b"a\r\nb\r\n"), &Some(b"a\nb\n".to_vec())));
        assert!(same_text(&None, &None));
        assert!(!same_text(&disk(b"a\r\nc\r\n"), &Some(b"a\nb\n".to_vec())));
        assert!(!same_text(&disk(b"a"), &None));
        assert!(!same_text(&None, &Some(b"a".to_vec())));
        // Present but unreadable is never clean.
        assert!(!same_text(&Some(None), &Some(b"a".to_vec())));
    }
}
