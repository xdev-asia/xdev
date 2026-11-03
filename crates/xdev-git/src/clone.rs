//! `git clone` with progress and cancel, for Add project › Clone from URL.

use std::io::{self, Read};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use xdev_ai::process::{kill_tree, own_group};

use crate::GitError;
use crate::run::git_command;

/// How often a clone checks `cancel` while git is quiet.
const POLL: Duration = Duration::from_millis(100);
/// After git exits, how long a process it left behind may hold stderr.
const DRAIN: Duration = Duration::from_secs(2);
/// The last lines of git's output kept for the error message.
const KEEP: usize = 20;

/// What `clone_repo` reports while git runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloneEvent {
    /// A `--progress` line such as `Receiving objects:  45% (9/20)`.
    Progress { phase: String, percent: Option<u8> },
    /// Any other line git printed.
    Line(String),
}

/// `BadUrl` unless `url` is `https://`, `ssh://`, `file://`, scp-like
/// `user@host:path` or an absolute local path. A leading `-` (an option to
/// git), control characters and `<transport>::` addresses (`ext::` runs a
/// command) are refused before any process starts.
pub fn check_clone_url(url: &str) -> Result<(), GitError> {
    let bad = || Err(GitError::BadUrl(url.to_owned()));
    if url.trim().is_empty() || url.starts_with('-') || url.chars().any(char::is_control) {
        return bad();
    }
    if let Some((transport, _)) = url.split_once("::")
        && !transport.is_empty()
        && transport
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return bad();
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        let known = ["https", "ssh", "file"]
            .iter()
            .any(|s| s.eq_ignore_ascii_case(scheme));
        return if known && !rest.is_empty() {
            Ok(())
        } else {
            bad()
        };
    }
    if Path::new(url).is_absolute() {
        return Ok(());
    }
    // scp-like: `[user@]host:path`, with a host longer than a drive letter.
    match url.split_once(':') {
        Some((host, path))
            if !path.is_empty()
                && !host.contains('/')
                && !host.contains('\\')
                && host.rsplit('@').next().is_some_and(|h| h.len() > 1) =>
        {
            Ok(())
        }
        _ => bad(),
    }
}

/// The folder name git would pick: the last part of `url` without `.git`.
/// `None` when that is empty or `.` / `..`.
pub fn clone_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next().unwrap_or("");
    let name = match last.len().checked_sub(4).and_then(|cut| last.get(cut..)) {
        Some(end) if end.eq_ignore_ascii_case(".git") => &last[..last.len() - 4],
        _ => last,
    };
    match name {
        "" | "." | ".." => None,
        _ => Some(name.to_owned()),
    }
}

/// One line of `git clone --progress` as an event. `remote: ` is dropped;
/// `Phase: NN% …` and `Phase: N, done.` are progress, the rest is a line.
pub fn parse_progress(line: &str) -> CloneEvent {
    let text = line.trim();
    let body = text
        .strip_prefix("remote:")
        .map(str::trim_start)
        .unwrap_or(text);
    let Some((phase, rest)) = body.split_once(':') else {
        return CloneEvent::Line(text.to_owned());
    };
    let rest = rest.trim_start();
    // Phases start with a capital (`Receiving objects`); `warning: 1 …`
    // and `fatal: …` do not.
    let is_phase = phase.starts_with(char::is_uppercase)
        && phase.chars().all(|c| c.is_alphabetic() || c == ' ')
        && rest.starts_with(|c: char| c.is_ascii_digit());
    if !is_phase {
        return CloneEvent::Line(text.to_owned());
    }
    let percent = rest
        .split_once('%')
        .and_then(|(n, _)| n.trim().parse::<u8>().ok())
        .filter(|p| *p <= 100);
    CloneEvent::Progress {
        phase: phase.trim().to_owned(),
        percent,
    }
}

/// Clones `url` into `dest`, which must not exist yet; its parent must.
/// Sends every stderr line to `on_event` and checks `cancel` at least every
/// 100 ms; a cancel kills git and everything it started and returns
/// `Cancelled`. A partly written `dest` is left for the caller.
pub fn clone_repo(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(CloneEvent),
) -> Result<(), GitError> {
    check_clone_url(url)?;
    let parent = dest.parent().filter(|p| p.is_dir()).ok_or_else(|| {
        GitError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            dest.display().to_string(),
        ))
    })?;
    if cancel.load(Ordering::Relaxed) {
        return Err(GitError::Cancelled);
    }
    let mut cmd = git_command(parent, true);
    cmd.args([
        "-c",
        "protocol.ext.allow=never",
        "clone",
        "--progress",
        "--",
    ])
    .arg(url)
    .arg(dest)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => GitError::NoGit,
        _ => GitError::Io(e),
    })?;
    let lines = lines_on_thread(child.stderr.take());

    let mut tail: Vec<String> = Vec::new();
    let mut take = |line: String, on_event: &mut dyn FnMut(CloneEvent)| {
        let event = parse_progress(&line);
        if let CloneEvent::Line(text) = &event {
            if tail.len() == KEEP {
                tail.remove(0);
            }
            tail.push(text.clone());
        }
        on_event(event);
    };
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            // The tree first: Windows finds the children by parent id.
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        match lines.recv_timeout(POLL) {
            Ok(line) => take(line, on_event),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {}
        }
    };
    while let Ok(line) = lines.recv_timeout(DRAIN) {
        take(line, on_event);
    }
    if !status.success() {
        return Err(GitError::Failed {
            args: "clone".to_owned(),
            status: status.code(),
            stderr: tail.join("\n"),
        });
    }
    Ok(())
}

/// Lines of `pipe` split at `\r` (progress redraws) and `\n`, empty ones
/// dropped. The channel closes when the pipe does.
fn lines_on_thread(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let Some(mut pipe) = pipe else { return };
        let mut buf = [0u8; 4096];
        let mut line = Vec::new();
        let send = |line: &mut Vec<u8>| {
            let text = String::from_utf8_lossy(line).trim().to_owned();
            line.clear();
            text.is_empty() || tx.send(text).is_ok()
        };
        loop {
            let n = match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    if !send(&mut line) {
                        return;
                    }
                } else {
                    line.push(b);
                }
            }
        }
        send(&mut line);
    });
    rx
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;

    #[test]
    fn progress_lines() {
        let progress = |phase: &str, percent| CloneEvent::Progress {
            phase: phase.into(),
            percent,
        };
        let table = [
            (
                "Receiving objects:  45% (9/20)",
                progress("Receiving objects", Some(45)),
            ),
            (
                "Receiving objects: 100% (20/20), 1.20 KiB | 1.20 MiB/s, done.",
                progress("Receiving objects", Some(100)),
            ),
            (
                "remote: Counting objects: 7% (1/14)",
                progress("Counting objects", Some(7)),
            ),
            (
                "remote: Enumerating objects: 14, done.",
                progress("Enumerating objects", None),
            ),
            (
                "Resolving deltas:   0% (0/3)",
                progress("Resolving deltas", Some(0)),
            ),
            ("Updating files: 250% (x)", progress("Updating files", None)),
            (
                "Cloning into 'xdev'...",
                CloneEvent::Line("Cloning into 'xdev'...".into()),
            ),
            (
                "Cloning into 'C:\\a b'...",
                CloneEvent::Line("Cloning into 'C:\\a b'...".into()),
            ),
            (
                "fatal: repository 'x' does not exist",
                CloneEvent::Line("fatal: repository 'x' does not exist".into()),
            ),
            (
                "warning: 1 thing",
                CloneEvent::Line("warning: 1 thing".into()),
            ),
        ];
        for (line, want) in table {
            assert_eq!(parse_progress(line), want, "{line}");
        }
    }

    #[test]
    fn url_rules() {
        let mut ok = vec![
            "https://github.com/a/xdev.git",
            "HTTPS://host/a/b",
            "ssh://git@host:22/a/b.git",
            "git@github.com:a/xdev.git",
            "host.example:team/repo",
            "file:///srv/git/x.git",
        ];
        ok.push(if cfg!(windows) {
            "C:\\code\\x"
        } else {
            "/srv/git/x"
        });
        for url in ok {
            assert!(check_clone_url(url).is_ok(), "{url}");
        }
        let bad = [
            "",
            "  ",
            "-u",
            "--upload-pack=touch x",
            "https://host/a\nb",
            "https://host/a\0b",
            "ext::sh -c touch% /tmp/x",
            "fd::3",
            "EXT::x",
            "http://host/a/b",
            "git://host/a/b",
            "ftp://host/a",
            "https://",
            "relative/path",
            "repo",
        ];
        for url in bad {
            assert_eq!(
                check_clone_url(url).unwrap_err().code(),
                "bad_arg",
                "{url:?}"
            );
        }
        if cfg!(windows) {
            // A drive letter is not an scp host.
            assert!(check_clone_url("C:code").is_err());
        }
    }

    #[test]
    fn clone_names() {
        for url in [
            "https://github.com/a/xdev.git",
            "git@github.com:a/xdev.git",
            "https://host/a/xdev/",
            "C:\\code\\xdev.GIT",
            "host:xdev",
        ] {
            assert_eq!(clone_name(url).as_deref(), Some("xdev"), "{url}");
        }
        for url in ["", "https://host/.git", "https://host/..", "/"] {
            assert_eq!(clone_name(url), None, "{url}");
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A bare repo with one commit, and the folder to clone into.
    fn origin(files: usize) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
        ] {
            git(&work, &["config", key, value]);
        }
        for i in 0..files {
            fs::write(
                work.join(format!("f{i}.txt")),
                format!("file {i}\n").repeat(50),
            )
            .unwrap();
        }
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-q", "-m", "one"]);
        let bare = tmp.path().join("origin.git");
        git(tmp.path(), &["clone", "-q", "--bare", "work", "origin.git"]);
        let into = tmp.path().join("into");
        fs::create_dir(&into).unwrap();
        (tmp, bare, into)
    }

    #[test]
    fn a_local_clone_works_and_reports() {
        let (_tmp, bare, into) = origin(3);
        let dest = into.join("my clone");
        let mut events = Vec::new();
        let url = bare.to_string_lossy().into_owned();
        clone_repo(&url, &dest, &AtomicBool::new(false), &mut |e| {
            events.push(e)
        })
        .unwrap();
        assert!(dest.join("f0.txt").is_file());
        assert!(!events.is_empty());
    }

    #[test]
    fn a_failed_clone_says_why() {
        let (_tmp, bare, into) = origin(1);
        let url = bare.join("missing").to_string_lossy().into_owned();
        let err =
            clone_repo(&url, &into.join("x"), &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        match err {
            GitError::Failed { args, stderr, .. } => {
                assert_eq!(args, "clone");
                assert!(!stderr.is_empty());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_bad_url_starts_no_git() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("ran");
        let url = format!("ext::sh -c touch% {}", marker.display());
        let err = clone_repo(
            &url,
            &tmp.path().join("x"),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_arg");
        assert!(!marker.exists());
        assert!(!tmp.path().join("x").exists());
    }

    #[test]
    fn a_cancel_before_the_start_runs_nothing() {
        let (_tmp, bare, into) = origin(1);
        let url = bare.to_string_lossy().into_owned();
        let err =
            clone_repo(&url, &into.join("x"), &AtomicBool::new(true), &mut |_| {}).unwrap_err();
        assert_eq!(err.code(), "cancelled");
        assert!(!into.join("x").exists());
    }

    /// Slow: builds a repo big enough that the clone is still running when
    /// the first event arrives.
    #[test]
    #[ignore]
    fn a_cancel_during_a_clone_stops_git() {
        let (_tmp, bare, into) = origin(4000);
        let url = format!("file://{}", bare.to_string_lossy().replace('\\', "/"));
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let err = clone_repo(&url, &into.join("x"), &cancel, &mut |_| {
            cancel.store(true, Ordering::Relaxed)
        })
        .unwrap_err();
        assert_eq!(err.code(), "cancelled");
        assert!(started.elapsed() < Duration::from_secs(30));
    }
}
