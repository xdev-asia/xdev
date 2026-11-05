//! The git history panel's commands: the commit graph, one commit's files
//! and diff, and opening a commit or a file on its web host.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use xdev_git::{CommitFiles, LOG_LIMIT_MAX, Repo, RepoLog, commit_url, file_url};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{
    MAX_BYTES, Skip, WorktreeFileDiff, bad_arg, inside, is_binary, known_checkout, skipped,
};

/// Opens a URL outside the app. A fake stands in for it in tests.
pub(crate) trait UrlOpener {
    fn open(&self, url: &str) -> Result<(), CmdError>;
}

fn log_with(data: &Path, path: &Path, limit: usize, skip: usize) -> Result<RepoLog, CmdError> {
    known_checkout(data, path)?;
    let repo = Repo::discover(path)?;
    Ok(repo.repo_log(None, limit.clamp(1, LOG_LIMIT_MAX), skip)?)
}

fn commit_files_with(data: &Path, path: &Path, id: &str) -> Result<CommitFiles, CmdError> {
    known_checkout(data, path)?;
    Ok(Repo::discover(path)?.commit_files(id)?)
}

fn commit_file_with(
    data: &Path,
    path: &Path,
    id: &str,
    file: &str,
) -> Result<WorktreeFileDiff, CmdError> {
    known_checkout(data, path)?;
    inside(path, file).ok_or_else(|| bad_arg(file))?;
    let repo = Repo::discover(path)?;
    let parent = repo.first_parent(id)?;
    // Sized before it is read, so a large file never sits in memory.
    let new_size = repo.blob_size(id, file)?;
    let old_size = match &parent {
        Some(parent) => repo.blob_size(parent, file)?,
        None => None,
    };
    if [old_size, new_size]
        .into_iter()
        .flatten()
        .any(|n| n > MAX_BYTES)
    {
        return Ok(skipped(Skip::TooLarge));
    }
    let new = match new_size {
        Some(_) => repo.show(id, file)?,
        None => None,
    };
    let old = match (&parent, old_size) {
        (Some(parent), Some(_)) => repo.show(parent, file)?,
        _ => None,
    };
    if [&old, &new].into_iter().flatten().any(|b| is_binary(b)) {
        return Ok(skipped(Skip::Binary));
    }
    // Both sides passed the UTF-8 check in `is_binary`.
    let text = |bytes: Option<Vec<u8>>| bytes.and_then(|b| String::from_utf8(b).ok());
    Ok(WorktreeFileDiff {
        old: text(old),
        new: text(new),
        skip: None,
    })
}

/// The URL is built here and never comes from the UI; only these three
/// hosts over https are opened.
fn guarded(url: String) -> Result<String, CmdError> {
    const HOSTS: [&str; 3] = [
        "https://github.com/",
        "https://gitlab.com/",
        "https://bitbucket.org/",
    ];
    if HOSTS.iter().any(|h| url.starts_with(h)) {
        Ok(url)
    } else {
        Err(CmdError {
            code: "no_web_remote",
            detail: None,
        })
    }
}

fn open_commit_with(
    opener: &dyn UrlOpener,
    data: &Path,
    path: &Path,
    id: &str,
) -> Result<(), CmdError> {
    known_checkout(data, path)?;
    let repo = Repo::discover(path)?;
    // Refuses anything but a full hex id, and an id this repo lacks.
    repo.first_parent(id)?;
    let host = repo.origin_host()?.ok_or(xdev_git::GitError::NoWebRemote)?;
    opener.open(&guarded(commit_url(&host, id))?)
}

fn open_file_with(
    opener: &dyn UrlOpener,
    data: &Path,
    path: &Path,
    file: &str,
    line: Option<u32>,
    end_line: Option<u32>,
) -> Result<(), CmdError> {
    known_checkout(data, path)?;
    inside(path, file).ok_or_else(|| bad_arg(file))?;
    let repo = Repo::discover(path)?;
    let (host, git_ref) = repo
        .file_host_target()?
        .ok_or(xdev_git::GitError::NoWebRemote)?;
    let file = file.replace('\\', "/");
    opener.open(&guarded(file_url(&host, &git_ref, &file, line, end_line))?)
}

/// The opener plugin, called from Rust only; the webview has no permission
/// to call it.
pub(crate) struct PluginOpener<'a>(pub(crate) &'a AppHandle);

impl UrlOpener for PluginOpener<'_> {
    fn open(&self, url: &str) -> Result<(), CmdError> {
        use tauri_plugin_opener::OpenerExt;
        self.0
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| CmdError {
                code: "open_failed",
                detail: Some(e.to_string()),
            })
    }
}

#[tauri::command(async)]
pub fn worktree_log(
    state: State<'_, AppState>,
    path: PathBuf,
    limit: usize,
    skip: usize,
) -> Result<RepoLog, CmdError> {
    log_with(data_dir(&state)?, &path, limit, skip)
}

#[tauri::command(async)]
pub fn worktree_commit_files(
    state: State<'_, AppState>,
    path: PathBuf,
    id: String,
) -> Result<CommitFiles, CmdError> {
    commit_files_with(data_dir(&state)?, &path, &id)
}

#[tauri::command(async)]
pub fn worktree_commit_file(
    state: State<'_, AppState>,
    path: PathBuf,
    id: String,
    file: String,
) -> Result<WorktreeFileDiff, CmdError> {
    commit_file_with(data_dir(&state)?, &path, &id, &file)
}

#[tauri::command(async)]
pub fn worktree_open_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    id: String,
) -> Result<(), CmdError> {
    open_commit_with(&PluginOpener(&app), data_dir(&state)?, &path, &id)
}

#[tauri::command(async)]
pub fn worktree_open_file_on_host(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    file: String,
    line: Option<u32>,
    end_line: Option<u32>,
) -> Result<(), CmdError> {
    open_file_with(
        &PluginOpener(&app),
        data_dir(&state)?,
        &path,
        &file,
        line,
        end_line,
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{Registry, add_repo};

    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    struct Fixture {
        _tmp: TempDir,
        main: PathBuf,
        data: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("history cmd ");
        let main = tmp.path().join("main");
        let data = tmp.path().join("data");
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&main, &["config", key, value]);
        }
        fs::write(
            main.join("a.txt"),
            "one
",
        )
        .unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-q", "-m", "one"]);
        let mut reg = Registry::load(&data).unwrap();
        add_repo(&mut reg, &main, 0).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            main,
            data,
        }
    }

    fn commit(fx: &Fixture, name: &str, content: &[u8]) -> String {
        fs::write(fx.main.join(name), content).unwrap();
        git(&fx.main, &["add", "-A"]);
        git(&fx.main, &["commit", "-q", "-m", name]);
        git(&fx.main, &["rev-parse", "HEAD"])
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn a_commit_file_has_its_old_and_new_text() {
        let fx = fixture();
        let id = commit(
            &fx, "a.txt", b"two
",
        );
        let d = commit_file_with(&fx.data, &fx.main, &id, "a.txt").unwrap();
        assert_eq!(
            d.old.as_deref(),
            Some(
                "one
"
            )
        );
        assert_eq!(
            d.new.as_deref(),
            Some(
                "two
"
            )
        );
        assert!(d.skip.is_none());
    }

    #[test]
    fn a_file_added_or_deleted_has_one_side() {
        let fx = fixture();
        let added = commit(
            &fx, "b.txt", b"b
",
        );
        let d = commit_file_with(&fx.data, &fx.main, &added, "b.txt").unwrap();
        assert_eq!(
            (d.old, d.new.as_deref()),
            (
                None,
                Some(
                    "b
"
                )
            )
        );
        fs::remove_file(fx.main.join("b.txt")).unwrap();
        git(&fx.main, &["add", "-A"]);
        git(&fx.main, &["commit", "-q", "-m", "rm"]);
        let id = git(&fx.main, &["rev-parse", "HEAD"]);
        let d = commit_file_with(&fx.data, &fx.main, &id, "b.txt").unwrap();
        assert_eq!(
            (d.old.as_deref(), d.new),
            (
                Some(
                    "b
"
                ),
                None
            )
        );
    }

    #[test]
    fn a_root_commit_has_no_old_side() {
        let fx = fixture();
        let root = git(&fx.main, &["rev-list", "--max-parents=0", "HEAD"]);
        let d = commit_file_with(&fx.data, &fx.main, &root, "a.txt").unwrap();
        assert_eq!(
            (d.old, d.new.as_deref()),
            (
                None,
                Some(
                    "one
"
                )
            )
        );
    }

    #[test]
    fn a_large_or_binary_file_is_skipped() {
        let fx = fixture();
        let big = commit(&fx, "big.txt", &vec![b'x'; (MAX_BYTES + 1) as usize]);
        let d = commit_file_with(&fx.data, &fx.main, &big, "big.txt").unwrap();
        assert_eq!(d.skip, Some(Skip::TooLarge));
        assert!(d.old.is_none() && d.new.is_none());
        let bin = commit(&fx, "img.bin", &[0, 1, 2]);
        let d = commit_file_with(&fx.data, &fx.main, &bin, "img.bin").unwrap();
        assert_eq!(d.skip, Some(Skip::Binary));
    }

    #[test]
    fn a_bad_path_id_or_folder_is_refused() {
        let fx = fixture();
        let id = git(&fx.main, &["rev-parse", "HEAD"]);
        for file in ["../a.txt", "/etc/passwd", ""] {
            assert_eq!(
                code(commit_file_with(&fx.data, &fx.main, &id, file)),
                "bad_arg",
                "{file:?}"
            );
        }
        assert_eq!(
            code(commit_file_with(&fx.data, &fx.main, "--output=x", "a.txt")),
            "git"
        );
        let stranger = fx.main.join("..");
        assert_eq!(
            code(commit_file_with(&fx.data, &stranger, &id, "a.txt")),
            "worktree_unknown"
        );
    }

    struct FakeOpener(std::cell::RefCell<Vec<String>>);

    impl FakeOpener {
        fn new() -> FakeOpener {
            FakeOpener(Default::default())
        }
        fn opened(&self) -> Vec<String> {
            self.0.borrow().clone()
        }
    }

    impl UrlOpener for FakeOpener {
        fn open(&self, url: &str) -> Result<(), CmdError> {
            self.0.borrow_mut().push(url.to_owned());
            Ok(())
        }
    }

    fn hosted(fx: &Fixture) {
        git(
            &fx.main,
            &["remote", "add", "origin", "git@github.com:o/r.git"],
        );
    }

    #[test]
    fn a_commit_opens_on_the_origin_host() {
        let fx = fixture();
        hosted(&fx);
        let id = git(&fx.main, &["rev-parse", "HEAD"]);
        let opener = FakeOpener::new();
        open_commit_with(&opener, &fx.data, &fx.main, &id).unwrap();
        assert_eq!(
            opener.opened(),
            [format!("https://github.com/o/r/commit/{id}")]
        );
    }

    #[test]
    fn without_a_web_remote_nothing_is_opened() {
        let fx = fixture();
        let id = git(&fx.main, &["rev-parse", "HEAD"]);
        let opener = FakeOpener::new();
        assert_eq!(
            code(open_commit_with(&opener, &fx.data, &fx.main, &id)),
            "no_web_remote"
        );
        assert_eq!(
            code(open_file_with(
                &opener, &fx.data, &fx.main, "a.txt", None, None
            )),
            "no_web_remote"
        );
        git(
            &fx.main,
            &["remote", "add", "origin", "git@example.com:o/r.git"],
        );
        assert_eq!(
            code(open_commit_with(&opener, &fx.data, &fx.main, &id)),
            "no_web_remote"
        );
        assert!(opener.opened().is_empty());
    }

    #[test]
    fn a_file_opens_with_its_lines_and_a_bad_request_opens_nothing() {
        let fx = fixture();
        hosted(&fx);
        let opener = FakeOpener::new();
        open_file_with(&opener, &fx.data, &fx.main, "a.txt", Some(2), Some(5)).unwrap();
        let url = &opener.opened()[0];
        assert!(url.starts_with("https://github.com/o/r/blob/"), "{url}");
        assert!(url.ends_with("/a.txt#L2-L5"), "{url}");

        let id = git(&fx.main, &["rev-parse", "HEAD"]);
        for bad in ["../a.txt", "/etc/passwd", ""] {
            assert_eq!(
                code(open_file_with(&opener, &fx.data, &fx.main, bad, None, None)),
                "bad_arg"
            );
        }
        for bad in ["--output=x", "HEAD", "zz"] {
            assert_eq!(
                code(open_commit_with(&opener, &fx.data, &fx.main, bad)),
                "git",
                "{bad}"
            );
        }
        let stranger = fx.main.join("..");
        assert_eq!(
            code(open_commit_with(&opener, &fx.data, &stranger, &id)),
            "worktree_unknown"
        );
        assert_eq!(opener.opened().len(), 1);
    }

    #[test]
    fn only_https_urls_on_the_three_hosts_pass_the_guard() {
        for ok in [
            "https://github.com/o/r",
            "https://gitlab.com/g/r",
            "https://bitbucket.org/w/r",
        ] {
            assert_eq!(guarded(ok.to_owned()).unwrap(), ok);
        }
        for bad in [
            "http://github.com/o/r",
            "https://github.com.evil.example/o/r",
            "https://evil.example/github.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(code(guarded(bad.to_owned())), "no_web_remote", "{bad}");
        }
    }
}
