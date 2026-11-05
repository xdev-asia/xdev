//! Terminal links: resolve a printed path to a worktree file, open a file or a URL with the OS,
//! and build the hosted URL of a file line. No shell is involved anywhere: a program is started
//! with its arguments, so URL text is never parsed by a shell.
//!
//! `open_url` is called from the webview, so its input is checked here and not only in the UI:
//! only `http` and `https` URLs without whitespace, control characters or quotes, at most 2 048
//! bytes. Any other scheme (`file:`, `javascript:`, `data:`, ...) is refused. The URL then goes to
//! the opener plugin from Rust, the way the history panel opens a commit; the webview has no
//! permission to call the plugin itself. Unlike the history panel, a terminal URL may name any
//! host, which is the point of a terminal link and is a deliberate choice.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, State};
use xdev_git::{GitError, HostRepo, Repo, file_url};
use xdev_workspace::{entry_path, link_rel, media_kind};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::history::{PluginOpener, UrlOpener};
use crate::reveal::reveal;
use crate::workspace::{bad_arg, known_checkout};

/// Most candidates one `file_links_resolve` call takes, and the longest one.
const MAX_PATHS: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
/// The longest URL `open_url` takes.
const MAX_URL_BYTES: usize = 2048;
/// The whole `file_remote_url` lookup answers within this, or it is a `timeout`.
const REMOTE_DEADLINE: Duration = Duration::from_secs(5);

fn io_error(e: &io::Error) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
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

/// Document extensions a terminal link may open with the default app, besides what
/// `media_kind` shows in the app (images, audio, video). Compared without case.
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "html", "htm", "csv", "json",
    "log",
];

/// An allowlist, not a denylist: only the last extension counts, so `a.pdf.exe` is refused, and
/// a name with no extension is refused.
fn default_open_allowed(rel: &str) -> bool {
    if media_kind(rel).is_some() {
        return true;
    }
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty()
            && DOCUMENT_EXTENSIONS
                .iter()
                .any(|x| x.eq_ignore_ascii_case(ext))
    })
}

fn open_default_in(
    data: &Path,
    worktree: &Path,
    rel: &str,
    run: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), CmdError> {
    known_checkout(data, worktree)?;
    let path = entry_path(&worktree.to_string_lossy(), rel)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|e| io_error(&e))?;
    if !meta.is_file() {
        return Err(CmdError {
            code: "bad_path",
            detail: Some(rel.to_owned()),
        });
    }
    if !default_open_allowed(rel) {
        return Err(CmdError {
            code: "denied",
            detail: Some(rel.to_owned()),
        });
    }
    run(&path).map_err(|e| io_error(&e))
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

fn open_url_with(opener: &dyn UrlOpener, url: &str) -> Result<(), CmdError> {
    if !web_url(url) {
        return Err(bad_arg("url"));
    }
    opener.open(url)
}

type Target = Option<(HostRepo, String)>;

/// Runs `find` on a thread so the caller can stop waiting after `deadline`. Git calls inside have
/// their own limits; a lookup that outlives the deadline is left to finish and its answer dropped.
fn lookup_within(
    worktree: PathBuf,
    deadline: Duration,
    find: impl FnOnce(PathBuf) -> Result<Target, GitError> + Send + 'static,
) -> Result<Target, GitError> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(find(worktree));
    });
    rx.recv_timeout(deadline).unwrap_or(Err(GitError::Timeout))
}

fn remote_url_with(
    data: &Path,
    worktree: &Path,
    rel: &str,
    line: u32,
    end_line: Option<u32>,
    deadline: Duration,
    find: impl FnOnce(PathBuf) -> Result<Target, GitError> + Send + 'static,
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
    let found = match lookup_within(worktree.to_path_buf(), deadline, find) {
        Ok(found) => found,
        Err(GitError::Timeout) => {
            return Err(CmdError {
                code: "timeout",
                detail: None,
            });
        }
        Err(e) => return Err(e.into()),
    };
    let (host, git_ref) = found.ok_or(GitError::NoWebRemote)?;
    Ok(file_url(&host, &git_ref, &clean, Some(line), end_line))
}

fn remote_url_in(
    data: &Path,
    worktree: &Path,
    rel: &str,
    line: u32,
    end_line: Option<u32>,
) -> Result<String, CmdError> {
    remote_url_with(
        data,
        worktree,
        rel,
        line,
        end_line,
        REMOTE_DEADLINE,
        |dir| Repo::discover(&dir)?.file_host_target(),
    )
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

/// Opens `rel` with the OS default app. Only images, audio, video and a small set of documents
/// (txt md pdf png jpg jpeg gif webp svg html htm csv json log) open; any other file is `denied`.
/// `not_found`, `bad_path`, `denied`, `io`.
#[tauri::command(async)]
pub fn file_open_default(
    state: State<'_, AppState>,
    worktree: PathBuf,
    rel: String,
) -> Result<(), CmdError> {
    open_default_in(data_dir(&state)?, &worktree, &rel, |p| reveal(p, false))
}

/// Opens an http(s) URL in the system browser. `bad_arg` for any other scheme, `open_failed`.
#[tauri::command(async)]
pub fn open_url(app: AppHandle, url: String) -> Result<(), CmdError> {
    open_url_with(&PluginOpener(&app), &url)
}

/// The hosted web URL of `rel` at `line` (to `end_line` when greater). `no_web_remote` when no
/// GitHub/GitLab/Bitbucket remote gives one; `timeout` after 5 s in all.
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

    /// Records the URLs it is asked to open instead of starting a browser.
    struct Recorder {
        seen: RefCell<Vec<String>>,
        fail: bool,
    }

    impl UrlOpener for Recorder {
        fn open(&self, url: &str) -> Result<(), CmdError> {
            if self.fail {
                return Err(CmdError {
                    code: "open_failed",
                    detail: Some("no browser".to_owned()),
                });
            }
            self.seen.borrow_mut().push(url.to_owned());
            Ok(())
        }
    }

    fn url_launch_of(url: &str) -> Result<Vec<String>, &'static str> {
        let rec = Recorder {
            seen: RefCell::default(),
            fail: false,
        };
        open_url_with(&rec, url).map_err(|e| e.code)?;
        Ok(rec.seen.into_inner())
    }

    #[test]
    fn open_url_accepts_http_and_https_only() {
        for url in [
            "https://x.dev/a?b#c",
            "http://x.dev",
            "HTTP://x.dev/UPPER",
            "HtTpS://x.dev/a?b=1&c=%20d",
        ] {
            assert_eq!(url_launch_of(url), Ok(vec![url.to_owned()]), "{url}");
        }
        for url in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///etc/passwd",
            "FILE:///etc/passwd",
            "mailto:a@b.c",
            "ssh://h/x",
            "ftp://h/x",
            "data:text/html,x",
            "vbscript:x",
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
            "http:file:///etc/passwd",
        ] {
            assert_eq!(url_launch_of(url), Err("bad_arg"), "{url:?}");
        }
    }

    #[test]
    fn open_url_has_a_2048_byte_limit() {
        let head = "https://x.dev/";
        let ok = format!("{head}{}", "a".repeat(2048 - head.len()));
        assert_eq!(url_launch_of(&ok), Ok(vec![ok.clone()]));
        assert_eq!(url_launch_of(&format!("{ok}a")), Err("bad_arg"));
    }

    #[test]
    fn open_url_reports_an_opener_that_fails() {
        let rec = Recorder {
            seen: RefCell::default(),
            fail: true,
        };
        let err = open_url_with(&rec, "https://x.dev").unwrap_err();
        assert_eq!(err.code, "open_failed");
        assert_eq!(err.detail.as_deref(), Some("no browser"));
    }

    // ---- file_open_default --------------------------------------------------------------------

    fn file_launch_of(fx: &Fixture, rel: &str) -> Result<PathBuf, &'static str> {
        let seen = RefCell::new(None);
        open_default_in(&fx.data, &fx.repo, rel, |p| {
            *seen.borrow_mut() = Some(p.to_path_buf());
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
            Ok(fx.repo.join("notes.txt"))
        );
        assert_eq!(
            file_launch_of(&fx, "./notes.txt"),
            Ok(fx.repo.join("notes.txt"))
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
    fn default_open_allows_documents_and_media_without_case() {
        for name in [
            "a.txt", "a.MD", "a.Pdf", "a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg",
            "a.html", "a.htm", "a.csv", "a.json", "a.LOG", "a.mp3", "a.mp4", "a.bmp",
        ] {
            assert!(default_open_allowed(name), "{name}");
        }
    }

    #[test]
    fn default_open_denies_anything_else() {
        for name in [
            "a.exe",
            "a.sh",
            "a.rs",
            "a.ts",
            "a.url",
            "a.terminal",
            "a.jar",
            "a.app",
            "a.py",
            "Makefile",
            "noext",
            ".txt",
            "a.",
            "a.txt.exe",
            "a.pdf.exe",
            "a.EXE.PDF.sh",
        ] {
            assert!(!default_open_allowed(name), "{name}");
        }
        // A dot in a folder name is not an extension.
        assert!(!default_open_allowed("v1.2/run"));
        assert!(!default_open_allowed("docs.txt/run"));
    }

    #[test]
    fn default_open_refuses_a_denied_file_before_launching() {
        let fx = fixture();
        for name in ["run.sh", "setup.EXE", "README", "a.pdf.exe", "x.url"] {
            fs::write(fx.repo.join(name), "x").unwrap();
            assert_eq!(file_launch_of(&fx, name), Err("denied"), "{name}");
        }
        fs::write(fx.repo.join("Doc.PDF"), "x").unwrap();
        assert_eq!(file_launch_of(&fx, "Doc.PDF"), Ok(fx.repo.join("Doc.PDF")));
    }

    #[cfg(unix)]
    #[test]
    fn default_open_ignores_the_exec_bit_of_an_allowed_type() {
        use std::os::unix::fs::PermissionsExt;
        let fx = fixture();
        let doc = fx.repo.join("a.pdf");
        fs::write(&doc, "x").unwrap();
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(file_launch_of(&fx, "a.pdf"), Ok(doc));
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
    fn remote_url_says_no_web_remote_without_a_hosted_one() {
        let fx = fixture();
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "src/a.ts", 3, None)),
            "no_web_remote"
        );
        git(&fx.repo, &["remote", "add", "origin", "/srv/git/local.git"]);
        assert_eq!(
            code(remote_url_in(&fx.data, &fx.repo, "src/a.ts", 3, None)),
            "no_web_remote"
        );
    }

    #[test]
    fn remote_url_builds_the_hosted_url_of_a_clean_path() {
        let fx = fixture();
        git(
            &fx.repo,
            &["remote", "add", "origin", "git@github.com:o/r.git"],
        );
        // No tracking ref and no `origin/HEAD` yet: the same fallback as the history panel.
        assert_eq!(
            remote_url_in(&fx.data, &fx.repo, "src/a.ts", 3, None).unwrap(),
            "https://github.com/o/r/blob/main/src/a.ts#L3"
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
    fn remote_url_reads_the_remotes_the_history_panel_reads() {
        let fx = fixture();
        git(
            &fx.repo,
            &[
                "remote",
                "add",
                "origin",
                "ssh://git@ssh.github.com:443/o/r%20x.git",
            ],
        );
        assert_eq!(
            remote_url_in(&fx.data, &fx.repo, "notes.txt", 2, None).unwrap(),
            "https://github.com/o/r%20x/blob/main/notes.txt#L2"
        );
    }

    #[test]
    fn remote_url_gives_up_after_one_overall_deadline() {
        let fx = fixture();
        let (release, hold) = std::sync::mpsc::channel::<()>();
        let err = remote_url_with(
            &fx.data,
            &fx.repo,
            "notes.txt",
            1,
            None,
            Duration::from_secs(2),
            move |_| {
                // A lookup that is still running when the deadline passes.
                let _ = hold.recv();
                Ok(None)
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "timeout");
        let _ = release.send(());
    }

    #[test]
    fn remote_url_passes_a_lookup_that_answers_in_time() {
        let fx = fixture();
        let host = xdev_git::parse_host_remote("git@gitlab.com:g/s/r.git").unwrap();
        let url = remote_url_with(
            &fx.data,
            &fx.repo,
            "src/a.ts",
            4,
            Some(6),
            Duration::from_secs(30),
            move |_| Ok(Some((host, "dev".to_owned()))),
        )
        .unwrap();
        assert_eq!(url, "https://gitlab.com/g/s/r/-/blob/dev/src/a.ts#L4-6");
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
