//! Worktree-relative paths to `file:` URIs and back.

use std::path::{Component, Path};

use url::Url;

use crate::LspError;

/// The URI of `rel` under `worktree`. `rel` uses `/` and stays inside.
pub fn uri_of(worktree: &Path, rel: &str) -> Result<Url, LspError> {
    let mut path = worktree.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        match Path::new(part).components().next() {
            Some(Component::Normal(_)) if Path::new(part).components().count() == 1 => {
                path.push(part)
            }
            _ => return Err(LspError::Outside),
        }
    }
    if path == worktree {
        return Err(LspError::Outside);
    }
    Url::from_file_path(&path).map_err(|()| LspError::Outside)
}

/// `uri` relative to `worktree` with `/` between parts; None for a URI that
/// is not a file inside it, after resolving links on both sides.
pub fn rel_of(worktree: &Path, uri: &Url) -> Option<String> {
    if uri.scheme() != "file" {
        return None;
    }
    let path = uri.to_file_path().ok()?;
    if let Some(rel) = relative(worktree, &path) {
        return Some(rel);
    }
    let root = worktree.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    relative(&root, &path)
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rest.components() {
        match c {
            Component::Normal(p) => parts.push(p.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_spaces_and_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("my repo");
        for rel in ["src/main.rs", "a b/c#d.ts", "ünï/çodé.py"] {
            let uri = uri_of(&root, rel).unwrap();
            assert_eq!(uri.scheme(), "file");
            assert!(!uri.as_str().contains(' '), "{uri}");
            assert!(uri.fragment().is_none(), "{uri}");
            assert_eq!(rel_of(&root, &uri).as_deref(), Some(rel));
        }
    }

    #[test]
    fn outside_is_refused_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("w");
        assert_eq!(uri_of(&root, "../x"), Err(LspError::Outside));
        assert_eq!(uri_of(&root, ""), Err(LspError::Outside));
        let other = Url::from_file_path(dir.path().join("other/x.rs")).unwrap();
        assert_eq!(rel_of(&root, &other), None);
        let root_uri = Url::from_directory_path(&root).unwrap();
        assert_eq!(rel_of(&root, &root_uri), None);
        let web = Url::parse("https://example.invalid/w/x.rs").unwrap();
        assert_eq!(rel_of(&root, &web), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_root_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(real.join("src")).unwrap();
        std::fs::write(real.join("src/a.rs"), "").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let uri = Url::from_file_path(real.join("src/a.rs")).unwrap();
        assert_eq!(rel_of(&link, &uri).as_deref(), Some("src/a.rs"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_round_trip() {
        let root = Path::new(r"C:\Users\me\my repo");
        let uri = uri_of(root, "src/a#b.ts").unwrap();
        assert!(
            uri.as_str().starts_with("file:///C:/Users/me/my%20repo/"),
            "{uri}"
        );
        assert_eq!(rel_of(root, &uri).as_deref(), Some("src/a#b.ts"));
    }
}
