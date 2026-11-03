//! Finding programs: whether an agent CLI or a shell is installed.

use std::env;
use std::ffi::OsStr;
use std::path::{self, PathBuf};

use xdev_ai::{claude_command, codex_command};

use crate::profiles::Cli;

/// What Windows tries as an extension when `PATHEXT` is unset.
const DEFAULT_PATHEXT: &str = ".EXE;.CMD;.BAT;.COM";

/// The file `program` names. A path (it has a separator) must be a file; a
/// bare name is searched on `PATH`, with each `PATHEXT` extension on Windows.
pub fn find_program(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    if cfg!(windows) {
        let pathext = env::var("PATHEXT").unwrap_or_default();
        let pathext = if pathext.trim().is_empty() {
            DEFAULT_PATHEXT
        } else {
            &pathext
        };
        find_in(program, &path, pathext)
    } else {
        find_in(program, &path, "")
    }
}

/// `find_program` over the given `PATH` list and `PATHEXT` extensions
/// (`;`-separated, empty for none).
pub(crate) fn find_in(program: &str, path: &OsStr, pathext: &str) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }
    let extensions = || pathext.split(';').map(str::trim).filter(|e| !e.is_empty());
    let candidates = |base: PathBuf| {
        let mut all = vec![base.clone()];
        all.extend(extensions().map(|ext| {
            let mut name = base.clone().into_os_string();
            name.push(ext);
            PathBuf::from(name)
        }));
        all
    };
    if program.contains(path::is_separator) {
        return Some(PathBuf::from(program)).filter(|p| p.is_file());
    }
    env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| {
            candidates(dir.join(program))
                .into_iter()
                .find(|p| p.is_file())
        })
}

/// Where a built-in agent CLI is installed. Claude and Codex go through
/// `xdev_ai`, so `XDEV_CLAUDE_BIN` and `XDEV_CODEX_BIN` keep working.
pub fn find_builtin(cli: Cli) -> Option<PathBuf> {
    match cli {
        Cli::Claude => claude_command()
            .ok()
            .map(|c| PathBuf::from(c.get_program())),
        Cli::Codex => codex_command().ok().map(|c| PathBuf::from(c.get_program())),
        Cli::Gemini => find_program("gemini"),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn path_of(dirs: &[&std::path::Path]) -> std::ffi::OsString {
        env::join_paths(dirs).unwrap()
    }

    #[test]
    fn find_program_uses_pathext() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("tool.CMD"), "").unwrap();
        fs::write(dir.path().join("plain"), "").unwrap();
        let path = path_of(&[dir.path()]);

        let found = find_in("tool", &path, ".EXE;.CMD").unwrap();
        assert_eq!(found, dir.path().join("tool.CMD"));
        // Without the extension list only the exact name matches.
        assert_eq!(find_in("tool", &path, ""), None);
        assert_eq!(
            find_in("plain", &path, ".EXE"),
            Some(dir.path().join("plain"))
        );
        assert_eq!(find_in("missing", &path, ".EXE;.CMD"), None);
        assert_eq!(find_in("", &path, ".EXE"), None);
    }

    #[test]
    fn find_program_takes_the_first_path_entry_that_has_it() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        fs::write(b.path().join("tool"), "").unwrap();
        let path = path_of(&[a.path(), b.path()]);
        assert_eq!(find_in("tool", &path, ""), Some(b.path().join("tool")));
        fs::write(a.path().join("tool"), "").unwrap();
        assert_eq!(find_in("tool", &path, ""), Some(a.path().join("tool")));
    }

    #[test]
    fn a_path_must_be_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tool");
        fs::write(&file, "").unwrap();
        // The PATH list is not searched for a path.
        let other = tempfile::tempdir().unwrap();
        let path = path_of(&[other.path()]);
        let text = file.to_string_lossy();
        assert_eq!(find_in(&text, &path, ""), Some(file.clone()));
        // A folder, or a file that is not there, is not a program.
        assert_eq!(find_in(&dir.path().to_string_lossy(), &path, ""), None);
        let gone = dir.path().join("gone");
        assert_eq!(find_in(&gone.to_string_lossy(), &path, ""), None);
        // Extensions are not tried on a path.
        let ext = dir.path().join("t");
        fs::write(ext.with_extension("EXE"), "").unwrap();
        assert_eq!(find_in(&ext.to_string_lossy(), &path, ".EXE"), None);
    }

    #[test]
    fn empty_path_entries_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("tool"), "").unwrap();
        let path = path_of(&[std::path::Path::new(""), dir.path()]);
        assert_eq!(find_in("tool", &path, ""), Some(dir.path().join("tool")));
    }
}
