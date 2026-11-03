use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::WorkspaceError;

const FILE: &str = "workspace.json";
const VERSION: u32 = 1;

/// A repo the app was asked to track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoEntry {
    pub id: String,
    pub short_name: String,
    pub path: PathBuf,
    pub base_ref: String,
    /// The folder new worktrees of this repo go under.
    pub worktree_root: PathBuf,
}

/// What the app knows about a linked worktree that git does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeMeta {
    pub repo_id: String,
    pub path: PathBuf,
    /// A full commit id.
    pub start: String,
    pub pinned: bool,
    pub created_ms: i64,
    /// Created by the app, not found already in git's list.
    pub made_here: bool,
}

/// A docs folder shared across repos. Only these are stored; a repo's own
/// vault is derived from its checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultEntry {
    /// The 12-hex path hash `repo_id` makes.
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub repos: Vec<RepoEntry>,
    pub worktrees: Vec<WorktreeMeta>,
    /// Absent in files written before vaults existed.
    #[serde(default)]
    pub vaults: Vec<VaultEntry>,
}

impl Registry {
    /// A missing file is an empty registry.
    pub fn load(data_dir: &Path) -> Result<Registry, WorkspaceError> {
        let text = match fs::read_to_string(data_dir.join(FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registry {
                    version: VERSION,
                    ..Registry::default()
                });
            }
            Err(e) => return Err(e.into()),
        };
        let reg: Registry =
            serde_json::from_str(&text).map_err(|e| WorkspaceError::Corrupt(e.to_string()))?;
        if reg.version != VERSION {
            return Err(WorkspaceError::Corrupt(format!(
                "unknown version {}",
                reg.version
            )));
        }
        Ok(reg)
    }

    /// Writes a temp file beside the target, then renames it over, so a
    /// crash leaves the old file or the new one, never half of one. A
    /// registry built with `Default` is written as the current version.
    pub fn save(&self, data_dir: &Path) -> Result<(), WorkspaceError> {
        fs::create_dir_all(data_dir)?;
        let out = Registry {
            version: VERSION,
            ..self.clone()
        };
        let json =
            serde_json::to_vec_pretty(&out).map_err(|e| WorkspaceError::Corrupt(e.to_string()))?;
        let tmp = data_dir.join(format!("{FILE}.tmp"));
        // Flushed to disk before the rename, so the new name never points at
        // a file whose contents are still in the cache.
        let write = || -> std::io::Result<()> {
            let mut file = fs::File::create(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
            fs::rename(&tmp, data_dir.join(FILE))
        };
        write().inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })?;
        Ok(())
    }
}

/// The path with `\` as `/`, lowercased on Windows where the file system
/// ignores case: the one form two spellings of a folder agree on.
pub(crate) fn normalize(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// The first 12 hex digits of the hash of the normalized path.
pub fn repo_id(path: &Path) -> String {
    let mut hex = blake3::hash(normalize(path).as_bytes())
        .to_hex()
        .to_string();
    hex.truncate(12);
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_an_empty_registry() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.version, 1);
        assert!(r.repos.is_empty());
    }

    #[test]
    fn save_is_atomic_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        r.repos.push(RepoEntry {
            id: "abc".into(),
            short_name: "xdev".into(),
            path: "/r".into(),
            base_ref: "main".into(),
            worktree_root: "/wt".into(),
        });
        r.save(dir.path()).unwrap();
        assert_eq!(Registry::load(dir.path()).unwrap(), r);
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["workspace.json"]); // no temp file left behind
    }

    #[test]
    fn loads_file_without_vaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":1,"repos":[],"worktrees":[]}"#,
        )
        .unwrap();
        let r = Registry::load(dir.path()).unwrap();
        assert!(r.vaults.is_empty());
    }

    #[test]
    fn vaults_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        r.vaults.push(VaultEntry {
            id: "0123456789ab".into(),
            path: "/v".into(),
        });
        r.save(dir.path()).unwrap();
        assert_eq!(Registry::load(dir.path()).unwrap().vaults, r.vaults);
    }

    #[test]
    fn unknown_version_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":2,"repos":[],"worktrees":[]}"#,
        )
        .unwrap();
        assert_eq!(
            Registry::load(dir.path()).unwrap_err().code(),
            "registry_corrupt"
        );
    }

    #[test]
    fn repo_id_ignores_slash_style_and_case_on_windows() {
        if cfg!(windows) {
            assert_eq!(
                repo_id(Path::new(r"E:\Codes\xDev\xdev")),
                repo_id(Path::new("e:/codes/xdev/xdev"))
            );
        }
        assert_eq!(repo_id(Path::new("/a")).len(), 12);
    }
}
