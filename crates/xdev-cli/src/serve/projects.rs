//! The folders `xdev serve` offers, from `--project`. Never the desktop's
//! repo list: a headless box often has none, and an explicit list is the
//! smallest exposure.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use xdev_link::{PeerProject, PeerRole};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// The first 16 hex characters of sha256 of the canonical path.
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct Projects(Vec<Project>);

impl Projects {
    /// Each path canonicalized, the same folder once. `serve_no_project`
    /// when one is missing or none is given.
    pub fn from_paths(paths: &[PathBuf]) -> Result<Projects, &'static str> {
        let mut out: Vec<Project> = Vec::new();
        for p in paths {
            let path = std::fs::canonicalize(p)
                .ok()
                .filter(|p| p.is_dir())
                .map(|p| plain(&p))
                .ok_or("serve_no_project")?;
            if out.iter().any(|q| q.path == path) {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            out.push(Project {
                id: id_of(&path),
                name,
                path,
            });
        }
        if out.is_empty() {
            return Err("serve_no_project");
        }
        Ok(Projects(out))
    }

    /// What `projects.list` answers; the path only for Admin.
    pub fn list(&self, role: PeerRole) -> Vec<PeerProject> {
        let admin = role.allows(PeerRole::Admin);
        self.0
            .iter()
            .map(|p| PeerProject {
                id: p.id.clone(),
                name: p.name.clone(),
                path: admin.then(|| p.path.display().to_string()),
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&Project> {
        self.0.iter().find(|p| p.id == id)
    }
}

fn id_of(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Drops Windows' `\\?\` prefix from a drive path: `cmd.exe` refuses such a
/// folder as its working folder.
fn plain(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("alpha");
        let b = tmp.path().join("beta");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        (tmp, a, b)
    }

    #[test]
    fn ids_are_stable_hex_and_distinct() {
        let (_tmp, a, b) = two();
        let p = Projects::from_paths(&[a.clone(), b.clone()]).unwrap();
        let list = p.list(PeerRole::Viewer);
        assert_eq!(list.len(), 2);
        for item in &list {
            assert_eq!(item.id.len(), 16);
            assert!(
                item.id
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
            );
        }
        assert_ne!(list[0].id, list[1].id);
        assert_eq!(list[0].name, "alpha");
        assert_eq!(list[1].name, "beta");
        let again = Projects::from_paths(&[a, b])
            .unwrap()
            .list(PeerRole::Viewer);
        assert_eq!(list, again);
    }

    #[test]
    fn missing_path_or_none() {
        let (tmp, a, _) = two();
        assert_eq!(
            Projects::from_paths(&[a, tmp.path().join("gone")]).unwrap_err(),
            "serve_no_project"
        );
        assert_eq!(Projects::from_paths(&[]).unwrap_err(), "serve_no_project");
    }

    #[test]
    fn path_only_for_admin() {
        let (_tmp, a, _) = two();
        let p = Projects::from_paths(std::slice::from_ref(&a)).unwrap();
        assert_eq!(p.list(PeerRole::Viewer)[0].path, None);
        assert_eq!(p.list(PeerRole::Operator)[0].path, None);
        let shown = p.list(PeerRole::Admin)[0].path.clone().unwrap();
        assert!(!shown.starts_with(r"\\?\"), "{shown}");
        assert_eq!(
            std::fs::canonicalize(&shown).unwrap(),
            std::fs::canonicalize(&a).unwrap()
        );
        let id = p.list(PeerRole::Admin)[0].id.clone();
        assert_eq!(p.get(&id).unwrap().name, "alpha");
        assert!(p.get("nope").is_none());
    }

    #[test]
    fn same_dir_twice_is_one() {
        let (_tmp, a, _) = two();
        let dotted = a.join(".");
        let p = Projects::from_paths(&[a.clone(), dotted, a]).unwrap();
        assert_eq!(p.list(PeerRole::Viewer).len(), 1);
    }

    #[test]
    fn verbatim_prefix_is_dropped_for_drives_only() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\src\app")),
            PathBuf::from(r"C:\src\app")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\srv\share")),
            PathBuf::from(r"\\?\UNC\srv\share")
        );
        assert_eq!(plain(Path::new("/src/app")), PathBuf::from("/src/app"));
    }
}
