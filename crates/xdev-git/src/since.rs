use std::collections::BTreeMap;

use crate::history::is_commit_id;
use crate::worktree::{NumStat, parse_numstat};
use crate::{ChangeKind, FileStatus, GitError, Repo, run};

impl Repo {
    /// Every file that differs from the commit `base` in the work tree:
    /// committed since, staged, unstaged or untracked (untracked counts as
    /// added), sorted by path. Paths are relative to the repo's top folder.
    /// `base` must be a full commit id, not a name.
    pub fn changes_since(&self, base: &str) -> Result<Vec<FileStatus>, GitError> {
        // Checked before git sees it, so `base` can never be read as an
        // option or a rev expression.
        if !is_commit_id(base) {
            return Err(GitError::BadId(base.to_owned()));
        }
        // From the top folder, so both lists cover the whole repo and use
        // the same paths wherever the repo was opened.
        let top = self.root();
        let diff = run::run(
            &top,
            &["diff", "--name-status", "-z", "--no-renames", base, "--"],
            None,
        )?;
        let untracked = run::run(
            &top,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
        )?;

        let mut found = parse_name_status(&diff);
        for path in fields(&untracked).filter(|p| !in_dependency_dir(p)) {
            found.insert(path.to_owned(), ChangeKind::Added);
        }
        Ok(found
            .into_iter()
            .map(|(path, kind)| FileStatus { path, kind })
            .collect())
    }

    /// Line counts of the tracked files that differ from the commit `base`
    /// in the work tree, renames shown as delete plus add. Untracked files
    /// are not in `git diff`; see `untracked`. `base` must be a full commit id.
    pub fn numstat_since(&self, base: &str) -> Result<Vec<NumStat>, GitError> {
        if !is_commit_id(base) {
            return Err(GitError::BadId(base.to_owned()));
        }
        let out = run::run(
            &self.root(),
            &["diff", "--numstat", "-z", "--no-renames", base, "--"],
            None,
        )?;
        Ok(parse_numstat(&out))
    }

    /// Untracked files that are not ignored, relative to the repo's top
    /// folder. A name that is not valid UTF-8 is left out.
    pub fn untracked(&self) -> Result<Vec<String>, GitError> {
        let out = run::run(
            &self.root(),
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
        )?;
        Ok(fields(&out)
            .filter(|p| !in_dependency_dir(p))
            .map(str::to_owned)
            .collect())
    }
}

/// Folders of installed packages and build output. An untracked file in one
/// is not a change the user made: a repo with no `.gitignore` would otherwise
/// count every file under `node_modules`.
const DEPENDENCY_DIRS: [&str; 8] = [
    "node_modules",
    ".venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    "target",
    "bower_components",
];

/// `path` lies inside one of `DEPENDENCY_DIRS`.
pub(crate) fn in_dependency_dir(path: &str) -> bool {
    let mut parts = path.split('/');
    // The last part is the file itself.
    parts.next_back();
    parts.any(|part| DEPENDENCY_DIRS.contains(&part))
}

/// NUL-separated fields; a name that is not valid UTF-8 cannot cross the
/// string-based API, so it is left out rather than mangled.
pub(crate) fn fields(out: &[u8]) -> impl Iterator<Item = &str> {
    out.split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .filter_map(|f| std::str::from_utf8(f).ok())
}

/// `-z` output: `<letter><NUL><path><NUL>` per file; with `--no-renames`
/// there is no second path.
fn parse_name_status(out: &[u8]) -> BTreeMap<String, ChangeKind> {
    let mut found = BTreeMap::new();
    let mut parts = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let (Some(code), Some(path)) = (parts.next(), parts.next()) {
        let Ok(path) = std::str::from_utf8(path) else {
            continue;
        };
        let kind = match code.first() {
            Some(b'A') => ChangeKind::Added,
            Some(b'D') => ChangeKind::Deleted,
            // `M`, and `T` for a type change.
            _ => ChangeKind::Modified,
        };
        found.insert(path.to_owned(), kind);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_and_keeps_odd_names() {
        let out = b"M\0a b.txt\0A\0dir/new.txt\0D\0gone.txt\0T\0link\0";
        let got: Vec<_> = parse_name_status(out).into_iter().collect();
        assert_eq!(
            got,
            [
                ("a b.txt".into(), ChangeKind::Modified),
                ("dir/new.txt".into(), ChangeKind::Added),
                ("gone.txt".into(), ChangeKind::Deleted),
                ("link".into(), ChangeKind::Modified),
            ]
        );
        assert!(parse_name_status(b"").is_empty());
    }

    #[test]
    fn files_under_installed_packages_are_not_changes() {
        assert!(in_dependency_dir("node_modules/a/index.js"));
        assert!(in_dependency_dir("web/node_modules/a.js"));
        assert!(in_dependency_dir("api/.venv/lib/x.py"));
        // A nested repo is listed as its folder.
        assert!(in_dependency_dir("node_modules/"));
        assert!(!in_dependency_dir("src/main.rs"));
        // Only a folder by that exact name counts, not a file or a look-alike.
        assert!(!in_dependency_dir("node_modules"));
        assert!(!in_dependency_dir("docs/node_modules.md"));
        assert!(!in_dependency_dir("my_node_modules/a.js"));
    }
}
