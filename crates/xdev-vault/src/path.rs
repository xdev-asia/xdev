use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::VaultError;

/// Tool and dependency folders: never docs, often huge.
const BUILTIN_SKIP: [&str; 4] = [".git", "node_modules", "target", ".xdev"];

pub(crate) fn is_builtin_skip(dir_name: &str) -> bool {
    BUILTIN_SKIP.contains(&dir_name)
}

pub(crate) fn is_md(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Vault-relative path with `/` separators, so the same doc has the same key
/// on every OS.
pub(crate) fn to_rel(root: &Path, full: &Path) -> Option<String> {
    let rel = full.strip_prefix(root).ok()?;
    let parts = rel
        .components()
        .map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// True when any folder between the root and the file is a built-in skip.
pub(crate) fn in_builtin_dir(rel: &str) -> bool {
    rel.split('/').rev().skip(1).any(is_builtin_skip)
}

pub(crate) fn io_error(rel: &str, err: io::Error) -> VaultError {
    if err.kind() == io::ErrorKind::NotFound {
        VaultError::NotFound(rel.to_owned())
    } else {
        VaultError::Io(err)
    }
}

pub(crate) fn resolve(root: &Path, rel: &str) -> Result<PathBuf, VaultError> {
    let outside = || VaultError::OutsideVault(rel.to_owned());
    let path = Path::new(rel);
    // Only plain names are allowed: `..`, a root, or a drive prefix could
    // point anywhere, and checking the parts is simpler than normalizing them.
    let mut has_name = false;
    for part in path.components() {
        match part {
            Component::Normal(_) => has_name = true,
            Component::CurDir => {}
            _ => return Err(outside()),
        }
    }
    if !has_name {
        return Err(VaultError::NotFound(rel.to_owned()));
    }

    // Canonicalizing follows symlinks, so a link pointing out of the vault is
    // caught here too.
    let joined = root.join(path);
    match fs::canonicalize(&joined) {
        Ok(real) if real.starts_with(root) => Ok(real),
        Ok(_) => Err(outside()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // A new file: its folder must already exist inside the vault.
            let (Some(parent), Some(name)) = (joined.parent(), joined.file_name()) else {
                return Err(outside());
            };
            let real_parent = fs::canonicalize(parent).map_err(|e| io_error(rel, e))?;
            if !real_parent.starts_with(root) {
                return Err(outside());
            }
            Ok(real_parent.join(name))
        }
        Err(e) => Err(io_error(rel, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_dir_check_ignores_file_name() {
        assert!(in_builtin_dir("node_modules/x.md"));
        assert!(in_builtin_dir("a/.git/x.md"));
        assert!(!in_builtin_dir("target.md"));
        assert!(!in_builtin_dir("docs/x.md"));
    }
}
