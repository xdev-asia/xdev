//! Terminal links: resolve a printed path to a worktree file, open a file or a URL with the OS,
//! and build the hosted URL of a file line. No shell is involved anywhere: a program is started
//! with its arguments, so URL text is never parsed by a shell.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::State;
use xdev_git::{GitError, Repo, hosted_file_url};
use xdev_workspace::{entry_path, link_rel};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::reveal::reveal;
use crate::workspace::{bad_arg, known_checkout};

/// Most candidates one `file_links_resolve` call takes, and the longest one.
const MAX_PATHS: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
/// The longest URL `open_url` takes.
const MAX_URL_BYTES: usize = 2048;

fn io_error(e: &io::Error) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

/// What `open_url` and `file_open_default` start; tests record it instead of starting it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launch {
    Url(String),
    File(PathBuf),
}

fn start(launch: Launch) -> io::Result<()> {
    match launch {
        Launch::File(path) => reveal(&path, false),
        Launch::Url(url) => {
            let (program, args) = url_launch(&url);
            let mut command = Command::new(program);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
                // One raw argument after the entry point: `&`, `%` and `^` stay as they are.
                for arg in &args {
                    command.raw_arg(arg);
                }
            }
            #[cfg(not(windows))]
            command.args(&args);
            let mut child = command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            // Reaped off the command thread; a browser launcher's exit code means nothing.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
    }
}

#[cfg(windows)]
fn url_launch(url: &str) -> (&'static str, Vec<OsString>) {
    (
        "rundll32.exe",
        vec!["url.dll,FileProtocolHandler".into(), url.into()],
    )
}

#[cfg(target_os = "macos")]
fn url_launch(url: &str) -> (&'static str, Vec<OsString>) {
    ("open", vec![url.into()])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn url_launch(url: &str) -> (&'static str, Vec<OsString>) {
    ("xdg-open", vec![url.into()])
}

/// The person's home folder, for `~/` in printed paths.
fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn resolve_in(
    data: &Path,
    worktree: &Path,
    paths: &[String],
    home: Option<&Path>,
) -> Result<Vec<Option<String>>, CmdError> {
    if paths.len() > MAX_PATHS {
        return Err(bad_arg("paths"));
    }
    if paths.iter().any(|p| p.len() > MAX_PATH_BYTES) {
        return Err(bad_arg("path"));
    }
    known_checkout(data, worktree)?;
    let root = worktree.to_string_lossy();
    Ok(paths.iter().map(|p| link_rel(&root, p, home)).collect())
}

/// Extensions Windows runs as a program or a script (compared without case).
const WINDOWS_RUNNABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msc",
    "scr", "lnk", "pif", "cpl", "hta", "reg",
];
/// Extensions macOS runs or launches when opened.
const MAC_RUNNABLE: &[&str] = &["app", "command", "tool"];

fn extension_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// A file that can run as a program: opening it with the default app could start it.
#[cfg_attr(not(unix), allow(unused_variables))]
fn can_run(path: &Path, meta: &std::fs::Metadata) -> bool {
    if cfg!(windows) && extension_in(path, WINDOWS_RUNNABLE) {
        return true;
    }
    if cfg!(target_os = "macos") && extension_in(path, MAC_RUNNABLE) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return true;
        }
    }
    false
}

fn open_default_in(
    data: &Path,
    worktree: &Path,
    rel: &str,
    run: impl FnOnce(Launch) -> io::Result<()>,
) -> Result<(), CmdError> {
    known_checkout(data, worktree)?;
    let path = entry_path(&worktree.to_string_lossy(), rel)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|e| io_error(&e))?;
    // A `.app` folder is a program, so it is refused rather than reported as a folder.
    if !meta.is_file() && !(cfg!(target_os = "macos") && extension_in(&path, MAC_RUNNABLE)) {
        return Err(CmdError {
            code: "bad_path",
            detail: Some(rel.to_owned()),
        });
    }
    if can_run(&path, &meta) {
        return Err(CmdError {
            code: "denied",
            detail: Some(rel.to_owned()),
        });
    }
    run(Launch::File(path)).map_err(|e| io_error(&e))
}

/// An `http` or `https` URL without control characters, spaces or quotes, at most 2 048 bytes.
fn web_url(url: &str) -> bool {
    let rest = ["http://", "https://"].iter().find_map(|p| {
        url.get(..p.len())
            .filter(|head| head.eq_ignore_ascii_case(p))
            .map(|_| &url[p.len()..])
    });
    rest.is_some_and(|rest| {
        !rest.is_empty()
            && url.len() <= MAX_URL_BYTES
            && !url
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == '"')
    })
}

fn open_url_with(url: &str, run: impl FnOnce(Launch) -> io::Result<()>) -> Result<(), CmdError> {
    if !web_url(url) {
        return Err(bad_arg("url"));
    }
    run(Launch::Url(url.to_owned())).map_err(|e| io_error(&e))
}

fn no_remote() -> CmdError {
    CmdError {
        code: "no_remote",
        detail: None,
    }
}

fn remote_url_in(
    data: &Path,
    worktree: &Path,
    rel: &str,
    line: u32,
    end_line: Option<u32>,
) -> Result<String, CmdError> {
    known_checkout(data, worktree)?;
    // The file must exist inside the worktree; the URL is built from its clean path.
    entry_path(&worktree.to_string_lossy(), rel)?;
    let clean = Path::new(rel)
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    let repo = Repo::discover(worktree)?;
    let found = match repo.remote_file_ref() {
        Ok(found) => found,
        Err(GitError::Timeout) => {
            return Err(CmdError {
                code: "timeout",
                detail: None,
            });
        }
        Err(e) => return Err(e.into()),
    };
    let (url, git_ref) = found.ok_or_else(no_remote)?;
    hosted_file_url(&url, &clean, &git_ref, line, end_line).ok_or_else(no_remote)
}

/// For each candidate as printed (`src/a.ts`, `./a.ts`, `/abs/a.ts`, `E:\wt\a.ts`, `~/wt/a.ts`,
/// `file:///abs/a.ts`; no `:line:col`), the worktree-relative path with `/` when it names an
/// existing regular file (not a link, not under `.git`) inside `worktree`; else `None`.
/// At most 64 candidates (`bad_arg` above), each at most 4 096 bytes.
#[tauri::command(async)]
pub fn file_links_resolve(
    state: State<'_, AppState>,
    worktree: PathBuf,
    paths: Vec<String>,
) -> Result<Vec<Option<String>>, CmdError> {
    resolve_in(data_dir(&state)?, &worktree, &paths, home().as_deref())
}

/// Opens `rel` with the OS default app. `not_found`, `bad_path`, `denied` (a file that can run as
/// a program), `io`.
#[tauri::command(async)]
pub fn file_open_default(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<(), CmdError> {
    open_default_in(data_dir(&state)?, &worktree, &rel, start)
}

/// Opens an http(s) URL in the system browser. `bad_arg`, `io`.
#[tauri::command(async)]
pub fn open_url(url: String) -> Result<(), CmdError> {
    open_url_with(&url, start)
}

/// The hosted web URL of `rel` at `line` (to `end_line` when greater). `no_remote` when no
/// GitHub/GitLab/Bitbucket remote gives one; `timeout` after 5 s.
#[tauri::command(async)]
pub fn file_remote_url(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
    line: u32,
    end_line: Option<u32>,
) -> Result<String, CmdError> {
    remote_url_in(data_dir(&state)?, &worktree, &rel, line, end_line)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{Registry, add_repo};

    use super::*;

    /// A repo with one commit, tracked by the registry in `data`, and a stranger folder.
    struct Fixture {
        _tmp: TempDir,
        repo: PathBuf,
        data: PathBuf,
        stranger: PathBuf,
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("links open ");
        let repo = tmp.path().join("repo");
        let data = tmp.path().join("data");
        let stranger = tmp.path().join("stranger");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::create_dir(&stranger).unwrap();
        fs::write(stranger.join("a.txt"), "theirs").unwrap();
        git(&repo, &["init", "-q", "--initial-branch=main"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&repo, &["config", key, value]);
        }
        fs::write(repo.join("src").join("a.ts"), "x\n").unwrap();
        fs::write(repo.join("notes.txt"), "x\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "one"]);
        let mut reg = Registry::load(&data).unwrap();
        add_repo(&mut reg, &repo, 0).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            repo,
            data,
            stranger,
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    // ---- file_links_resolve -------------------------------------------------------------------

    #[test]
    fn resolve_keeps_the_order_and_answers_none_for_a_miss() {
        let fx = fixture();
        let paths: Vec<String> = [
            "notes.txt",
            "missing.rs",
            "./src/a.ts",
            "src",
            "../outside.ts",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(
            resolve_in(&fx.data, &fx.repo, &paths, None).unwrap(),
            vec![
                Some("notes.txt".to_owned()),
                None,
                Some("src/a.ts".to_owned()),
                None,
                None
            ]
        );
        assert_eq!(
            resolve_in(&fx.data, &fx.repo, &[], None).unwrap(),
            Vec::<Option<String>>::new()
        );
    }

    #[test]
    fn resolve_takes_at_most_64_candidates_of_4096_bytes() {
        let fx = fixture();
        let many = |n: usize| vec!["notes.txt".to_owned(); n];
        assert_eq!(
            resolve_in(&fx.data, &fx.repo, &many(64), None)
                .unwrap()
                .len(),
            64
        );
        assert_eq!(
            code(resolve_in(&fx.data, &fx.repo, &many(65), None)),
            "bad_arg"
        );
        let long = vec!["a".repeat(4096)];
        assert!(resolve_in(&fx.data, &fx.repo, &long, None).is_ok());
        let longer = vec!["a".repeat(4097)];
        assert_eq!(
            code(resolve_in(&fx.data, &fx.repo, &longer, None)),
            "bad_arg"
        );
    }

    #[test]
    fn resolve_refuses_a_worktree_the_registry_does_not_know() {
        let fx = fixture();
        let one = vec!["a.txt".to_owned()];
        assert_eq!(
            code(resolve_in(&fx.data, &fx.stranger, &one, None)),
            "worktree_unknown"
        );
        // Checked before the limits' answer could leak whether a path exists.
        assert_eq!(
            code(resolve_in(&fx.data, &fx.stranger, &[], None)),
            "worktree_unknown"
        );
    }

    #[test]
    fn resolve_expands_the_home_folder() {
        let fx = fixture();
        let home = fx.repo.parent().unwrap();
        let one = vec!["~/repo/src/a.ts".to_owned()];
        assert_eq!(
            resolve_in(&fx.data, &fx.repo, &one, Some(home)).unwrap(),
            vec![Some("src/a.ts".to_owned())]
        );
    }

    // ---- open_url -----------------------------------------------------------------------------

    fn url_launch_of(url: &str) -> Result<Launch, &'static str> {
        let seen = RefCell::new(None);
        open_url_with(url, |l| {
            *seen.borrow_mut() = Some(l);
            Ok(())
        })
        .map_err(|e| e.code)?;
        Ok(seen.into_inner().expect("launched"))
    }

    #[test]
    fn open_url_accepts_http_and_https_only() {
        for url in [
            "https://x.dev/a?b#c",
            "http://x.dev",
            "HTTP://x.dev/UPPER",
            "HtTpS://x.dev/a?b=1&c=%20d",
        ] {
            assert_eq!(url_launch_of(url), Ok(Launch::Url(url.to_owned())), "{url}");
        }
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:a@b.c",
            "ssh://h/x",
            "ftp://h/x",
            "data:text/html,x",
            "x.dev/a",
            "",
            "https://",
            "http://",
            "https://x.dev/a b",
            "https://x.dev/a\nb",
            "https://x.dev/a\tb",
            "https://x.dev/a\0",
            "https://x.dev/\"quoted\"",
            " https://x.dev",
        ] {
            assert_eq!(url_launch_of(url), Err("bad_arg"), "{url:?}");
        }
    }

    #[test]
    fn open_url_has_a_2048_byte_limit() {
        let head = "https://x.dev/";
        let ok = format!("{head}{}", "a".repeat(2048 - head.len()));
        assert_eq!(url_launch_of(&ok), Ok(Launch::Url(ok.clone())));
        assert_eq!(url_launch_of(&format!("{ok}a")), Err("bad_arg"));
    }

    #[test]
    fn open_url_reports_a_launcher_that_fails() {
        let err = open_url_with("https://x.dev", |_| {
            Err(io::Error::new(io::ErrorKind::NotFound, "xdg-open missing"))
        })
        .unwrap_err();
        assert_eq!(err.code, "io");
        assert_eq!(err.detail.as_deref(), Some("xdg-open missing"));
    }

    #[test]
    fn the_launcher_gets_the_url_as_one_argument() {
        let url = "https://x.dev/a?b=1&c=%20d^e#f";
        let (program, args) = url_launch(url);
        assert_eq!(args.last().unwrap(), &OsString::from(url));
        if cfg!(windows) {
            assert_eq!(program, "rundll32.exe");
            assert_eq!(
                args,
                vec![
                    OsString::from("url.dll,FileProtocolHandler"),
                    OsString::from(url)
                ]
            );
        } else {
            assert_eq!(args, vec![OsString::from(url)]);
            assert!(program == "xdg-open" || program == "open");
        }
    }

    // ---- file_open_default --------------------------------------------------------------------

    fn file_launch_of(fx: &Fixture, rel: &str) -> Result<Launch, &'static str> {
        let seen = RefCell::new(None);
        open_default_in(&fx.data, &fx.repo, rel, |l| {
            *seen.borrow_mut() = Some(l);
            Ok(())
        })
        .map_err(|e| e.code)?;
        Ok(seen.into_inner().expect("launched"))
    }

    #[test]
    fn default_open_starts_a_plain_file_with_its_absolute_path() {
        let fx = fixture();
        assert_eq!(
            file_launch_of(&fx, "notes.txt"),
            Ok(Launch::File(fx.repo.join("notes.txt")))
        );
        assert_eq!(
            file_launch_of(&fx, "./src/a.ts"),
            Ok(Launch::File(fx.repo.join("src").join("a.ts")))
        );
    }

    #[test]
    fn default_open_refuses_a_missing_path_one_outside_and_a_folder() {
        let fx = fixture();
        assert_eq!(file_launch_of(&fx, "gone.txt"), Err("not_found"));
        assert_eq!(file_launch_of(&fx, "../stranger/a.txt"), Err("bad_path"));
        assert_eq!(file_launch_of(&fx, ".git/config"), Err("bad_path"));
        assert_eq!(file_launch_of(&fx, "src"), Err("bad_path"));
        let fx2 = fixture();
        let err = open_default_in(&fx2.data, &fx2.stranger, "a.txt", |_| Ok(())).unwrap_err();
        assert_eq!(err.code, "worktree_unknown");
    }

    #[test]
    fn windows_runnable_extensions_compare_without_case() {
        for name in [
            "a.exe", "a.EXE", "a.Cmd", "x.ps1", "x.JS", "x.lnk", "x.reg", "x.hta",
        ] {
            assert!(extension_in(Path::new(name), WINDOWS_RUNNABLE), "{name}");
        }
        for name in [
            "a.txt",
            "a.exe.txt",
            "exe",
            "a.json",
            "a.jsx",
            "a.ts",
            "a.md",
        ] {
            assert!(!extension_in(Path::new(name), WINDOWS_RUNNABLE), "{name}");
        }
        for name in ["A.APP", "x.command", "x.Tool"] {
            assert!(extension_in(Path::new(name), MAC_RUNNABLE), "{name}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn default_open_refuses_a_runnable_extension_on_windows() {
        let fx = fixture();
        for name in ["a.EXE", "b.Cmd", "c.ps1"] {
            fs::write(fx.repo.join(name), "x").unwrap();
            assert_eq!(file_launch_of(&fx, name), Err("denied"), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn default_open_refuses_a_file_with_an_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let fx = fixture();
        let script = fx.repo.join("run.sh");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(file_launch_of(&fx, "run.sh"), Err("denied"));
        // Only the owner's bit set still counts.
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(file_launch_of(&fx, "run.sh"), Err("denied"));
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            file_launch_of(&fx, "run.sh"),
            Ok(Launch::File(fx.repo.join("run.sh")))
        );
    }

    #[cfg(unix)]
    #[test]
    fn default_open_does_not_follow_a_link() {
        let fx = fixture();
        std::os::unix::fs::symlink(fx.repo.join("notes.txt"), fx.repo.join("link.txt")).unwrap();
        assert_eq!(file_launch_of(&fx, "link.txt"), Err("bad_path"));
    }

    // ---- file_remote_url ----------------------------------------------------------------------

    #[test]
    fn remote_url_says_no_remote_without_a_hosted_one() {
        let fx = fixture();
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "src/a.ts", 3, None)),
            "no_remote"
        );
        git(&fx.repo, &["remote", "add", "origin", "/srv/git/local.git"]);
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "src/a.ts", 3, None)),
            "no_remote"
        );
    }

    #[test]
    fn remote_url_builds_the_hosted_url_of_a_clean_path() {
        let fx = fixture();
        git(
            &fx.repo,
            &["remote", "add", "origin", "git@github.com:o/r.git"],
        );
        // No tracking ref and no `origin/HEAD` yet: nothing to name the file by.
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "src/a.ts", 3, None)),
            "no_remote"
        );
        git(
            &fx.repo,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        let id = {
            let out = Command::new("git")
                .current_dir(&fx.repo)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        };
        assert_eq!(
            remote_url_in(&fx.data, &fx.repo, "./src/a.ts", 3, Some(7)).unwrap(),
            format!("https://github.com/o/r/blob/{id}/src/a.ts#L3-L7")
        );
    }

    #[test]
    fn remote_url_checks_the_worktree_and_the_path() {
        let fx = fixture();
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.stranger, "a.txt", 1, None)),
            "worktree_unknown"
        );
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "../x.ts", 1, None)),
            "bad_path"
        );
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "gone.ts", 1, None)),
            "not_found"
        );
    }
}
