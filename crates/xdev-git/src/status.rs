use std::collections::BTreeMap;
use std::collections::btree_map::Entry;

use crate::{ChangeKind, FileStatus, GitError, Repo, run};

impl Repo {
    /// Every file under the vault that differs from `HEAD`, sorted by path.
    pub fn status(&self) -> Result<Vec<FileStatus>, GitError> {
        self.status_of(&["."])
    }

    pub(crate) fn status_of(&self, paths: &[&str]) -> Result<Vec<FileStatus>, GitError> {
        let mut args = vec![
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--",
        ];
        args.extend_from_slice(paths);
        let out = run::run(&self.workdir, &args, None)?;
        Ok(parse(&out, &self.prefix))
    }
}

/// Porcelain paths are relative to the repo root; `prefix` is the vault's
/// folder inside the repo.
fn parse(out: &[u8], prefix: &str) -> Vec<FileStatus> {
    let mut found = BTreeMap::new();
    for entry in out.split(|b| *b == 0) {
        // `XY path`; with `--no-renames` no entry carries a second path.
        if entry.len() < 4 || entry[2] != b' ' {
            continue;
        }
        let (x, y, path) = (entry[0], entry[1], &entry[3..]);
        // A name that is not valid UTF-8 cannot cross the string-based API,
        // so it is left out rather than mangled.
        let Some(path) = std::str::from_utf8(path)
            .ok()
            .and_then(|p| p.strip_prefix(prefix))
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        let kind = match (x, y) {
            (b'?', b'?') => ChangeKind::Added,
            // Staged as new, then deleted: in neither `HEAD` nor the disk.
            (b'A', b'D') => continue,
            (b'A', _) => ChangeKind::Added,
            _ if x == b'D' || y == b'D' => ChangeKind::Deleted,
            _ => ChangeKind::Modified,
        };
        match found.entry(path.to_owned()) {
            Entry::Vacant(e) => {
                e.insert(kind);
            }
            // `D ` plus `??` after `git rm --cached`: in `HEAD` and on disk.
            Entry::Occupied(mut e) => {
                e.insert(ChangeKind::Modified);
            }
        }
    }
    found
        .into_iter()
        .map(|(path, kind)| FileStatus { path, kind })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(out: &str, prefix: &str) -> Vec<(String, ChangeKind)> {
        parse(out.as_bytes(), prefix)
            .into_iter()
            .map(|s| (s.path, s.kind))
            .collect()
    }

    #[test]
    fn maps_codes() {
        let out =
            "?? a.md\0A  b.md\0AM c.md\0AD d.md\0 D e.md\0D  f.md\0MD g.md\0 M h.md\0MM i.md\0";
        assert_eq!(
            kinds(out, ""),
            [
                ("a.md".into(), ChangeKind::Added),
                ("b.md".into(), ChangeKind::Added),
                ("c.md".into(), ChangeKind::Added),
                ("e.md".into(), ChangeKind::Deleted),
                ("f.md".into(), ChangeKind::Deleted),
                ("g.md".into(), ChangeKind::Deleted),
                ("h.md".into(), ChangeKind::Modified),
                ("i.md".into(), ChangeKind::Modified),
            ]
        );
    }

    #[test]
    fn strips_prefix_and_skips_others() {
        assert_eq!(
            kinds("?? v/a.md\0?? outer.md\0", "v/"),
            [("a.md".into(), ChangeKind::Added)]
        );
    }
}
