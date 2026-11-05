//! The version an installed agent CLI reports, so the status hooks offer it
//! only the events it knows (an unknown hook event stops claude's TUI on a
//! warning dialog at every launch).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use crate::codex_home::CODEX_HOOKS_SINCE;
use crate::profiles::Cli;

/// `major.minor.patch`; anything after the patch number (`-beta.1`) is dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CliVersion(pub u32, pub u32, pub u32);

impl CliVersion {
    /// The first `x.y.z` word of `text`, as `claude --version`
    /// (`2.1.317 (Claude Code)`) and `codex --version` (`codex-cli 0.165.0`)
    /// print it. A leading `v` is allowed.
    pub fn parse(text: &str) -> Option<CliVersion> {
        text.split_whitespace().find_map(|word| {
            let word = word.strip_prefix('v').unwrap_or(word);
            let mut parts = word.splitn(3, '.');
            let major = parts.next()?.parse().ok()?;
            let minor = parts.next()?.parse().ok()?;
            let rest = parts.next()?;
            let digits = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            if digits == 0 {
                return None;
            }
            let patch = rest[..digits].parse().ok()?;
            Some(CliVersion(major, minor, patch))
        })
    }
}

impl std::fmt::Display for CliVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// How long `--version` may take before the CLI counts as unknown.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

type Cache = HashMap<(PathBuf, Option<SystemTime>), Option<CliVersion>>;

/// `<program> --version`, run once per program path and file time in this
/// process, so a launch does not wait on it again and an upgraded CLI is
/// asked anew. `None` when it does not start, fails, prints no version or
/// takes longer than 5 s.
pub fn cli_version(program: &Path) -> Option<CliVersion> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let modified = std::fs::metadata(program).and_then(|m| m.modified()).ok();
    let key = (program.to_path_buf(), modified);
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(found) = cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&key)
    {
        return *found;
    }
    let found = probe(program);
    cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(key, found);
    found
}

fn probe(program: &Path) -> Option<CliVersion> {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = spawn(&mut cmd)?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.by_ref().take(4096).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let bytes = match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    // The output is read; a CLI that lingers after printing is not waited on.
    let _ = child.kill();
    let _ = child.wait();
    CliVersion::parse(&String::from_utf8_lossy(&bytes))
}

/// What a launch check found out about an agent CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LaunchVerdict"))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Verdict {
    /// The program is not on the machine.
    NotInstalled,
    /// It runs but is older than the oldest version xDev launches.
    TooOld {
        found: String,
        min: String,
    },
    /// It did not report a version; `hint` is the first line it printed or
    /// the reason it did not start.
    Failed {
        hint: String,
    },
    Ok {
        version: String,
    },
}

/// The oldest version of `cli` xDev launches, for the agents where the repo
/// knows one: Codex before 0.136.0 has none of the hooks xDev adds. Other
/// agents have no minimum.
pub fn min_version(cli: Cli) -> Option<CliVersion> {
    match cli {
        Cli::Codex => Some(CODEX_HOOKS_SINCE),
        _ => None,
    }
}

/// What `--version` of an agent did: its output (stdout then stderr), the
/// exit code and why it did not start or finish, if so.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    pub output: String,
    pub exit: Option<i32>,
    pub spawn_error: Option<String>,
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

/// The verdict on an agent from what its `--version` did. Pure: no process
/// is started.
pub fn verdict(
    agent: Cli,
    version_output: &str,
    exit: Option<i32>,
    spawn_error: Option<&str>,
) -> Verdict {
    verdict_with(agent, min_version(agent), version_output, exit, spawn_error)
}

fn verdict_with(
    _agent: Cli,
    min: Option<CliVersion>,
    version_output: &str,
    exit: Option<i32>,
    spawn_error: Option<&str>,
) -> Verdict {
    if let Some(error) = spawn_error.map(str::trim).filter(|e| !e.is_empty()) {
        let lower = error.to_lowercase();
        let missing = [
            "not found",
            "no such file",
            "os error 2",
            "cannot find",
            "not recognized",
        ]
        .iter()
        .any(|m| lower.contains(m));
        return if missing {
            Verdict::NotInstalled
        } else {
            Verdict::Failed {
                hint: first_line(error),
            }
        };
    }
    match CliVersion::parse(version_output) {
        Some(found) => match min {
            Some(min) if found < min => Verdict::TooOld {
                found: found.to_string(),
                min: min.to_string(),
            },
            _ => Verdict::Ok {
                version: found.to_string(),
            },
        },
        None => {
            let line = first_line(version_output);
            Verdict::Failed {
                hint: if !line.is_empty() {
                    line
                } else {
                    exit.map_or_else(String::new, |c| format!("exit {c}"))
                },
            }
        }
    }
}

/// `<program> --version`, run now (not cached) with stdout and stderr read,
/// for the launch check. A program that does not finish in 5 s is killed and
/// reported as `timed out`. No network is used by xDev here; the CLI itself
/// may.
pub fn probe_version(program: &Path) -> Probe {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Probe {
                spawn_error: Some(e.to_string()),
                ..Probe::default()
            };
        }
    };
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.by_ref().take(4096).read_to_end(&mut bytes);
            }
            let _ = tx.send(bytes);
        });
        rx
    };
    let out = read(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = read(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.code()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => break None,
        }
    };
    let Some(exit) = exit else {
        let _ = child.kill();
        let _ = child.wait();
        return Probe {
            spawn_error: Some("timed out".to_owned()),
            ..Probe::default()
        };
    };
    let wait = Duration::from_secs(1);
    let mut output =
        String::from_utf8_lossy(&out.recv_timeout(wait).unwrap_or_default()).into_owned();
    output.push('\n');
    output.push_str(&String::from_utf8_lossy(
        &err.recv_timeout(wait).unwrap_or_default(),
    ));
    Probe {
        output,
        exit,
        spawn_error: None,
    }
}

/// ETXTBSY, the same number on Linux and macOS.
const TEXT_FILE_BUSY: i32 = 26;

/// Spawns, trying again a few times while the program is busy. A program written a moment ago can
/// still be open for writing in a child another thread has forked but not yet exec'd; that clears
/// in a few milliseconds. Any other error is final, and the failure is cached by the caller.
fn spawn(cmd: &mut Command) -> Option<std::process::Child> {
    for _ in 0..5 {
        match cmd.spawn() {
            Ok(child) => return Some(child),
            Err(e) if cfg!(unix) && e.raw_os_error() == Some(TEXT_FILE_BUSY) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
    cmd.spawn().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_the_clis_print() {
        assert_eq!(
            CliVersion::parse("2.1.317 (Claude Code)\n"),
            Some(CliVersion(2, 1, 317))
        );
        assert_eq!(
            CliVersion::parse("codex-cli 0.165.0"),
            Some(CliVersion(0, 165, 0))
        );
        assert_eq!(
            CliVersion::parse("tool v1.2.3-beta.1"),
            Some(CliVersion(1, 2, 3))
        );
        for bad in ["", "claude", "1.2", "a.b.c", "1.2.x"] {
            assert_eq!(CliVersion::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn orders_numerically() {
        assert!(CliVersion(0, 150, 0) > CliVersion(0, 136, 9));
        assert!(CliVersion(2, 1, 317) > CliVersion(2, 1, 99));
    }

    #[test]
    fn missing_program_has_no_version() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(cli_version(&dir.path().join("nope")), None);
    }

    #[test]
    fn reads_a_fake_cli_once() {
        let dir = tempfile::tempdir().unwrap();
        let count = dir.path().join("count");
        let program = if cfg!(windows) {
            let p = dir.path().join("fake.cmd");
            std::fs::write(
                &p,
                format!(
                    "@echo off\r\necho x>>\"{}\"\r\necho 2.1.317 (Claude Code)\r\n",
                    count.display()
                ),
            )
            .unwrap();
            p
        } else {
            let p = dir.path().join("fake");
            std::fs::write(
                &p,
                format!(
                    "#!/bin/sh\necho x >> '{}'\necho '2.1.317 (Claude Code)'\n",
                    count.display()
                ),
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        };
        assert_eq!(cli_version(&program), Some(CliVersion(2, 1, 317)));
        assert_eq!(cli_version(&program), Some(CliVersion(2, 1, 317)));
        let runs = std::fs::read_to_string(&count).unwrap();
        assert_eq!(runs.lines().count(), 1);
    }

    #[test]
    fn verdict_reads_a_version() {
        assert_eq!(
            verdict(Cli::Claude, "2.1.317 (Claude Code)", Some(0), None),
            Verdict::Ok {
                version: "2.1.317".into()
            }
        );
    }

    #[test]
    fn verdict_not_installed_from_the_spawn_error() {
        for e in [
            "No such file or directory (os error 2)",
            "program not found",
            "'x' is not recognized as an internal command",
        ] {
            assert_eq!(
                verdict(Cli::Claude, "", None, Some(e)),
                Verdict::NotInstalled,
                "{e}"
            );
        }
    }

    #[test]
    fn verdict_failed_keeps_a_short_hint() {
        assert_eq!(
            verdict(
                Cli::Claude,
                "",
                None,
                Some("Permission denied (os error 13)\nmore")
            ),
            Verdict::Failed {
                hint: "Permission denied (os error 13)".into()
            }
        );
        assert_eq!(
            verdict(Cli::Gemini, "\n  boom: bad flag\n", Some(2), None),
            Verdict::Failed {
                hint: "boom: bad flag".into()
            }
        );
        assert_eq!(
            verdict(Cli::Gemini, "", Some(3), None),
            Verdict::Failed {
                hint: "exit 3".into()
            }
        );
    }

    #[test]
    fn verdict_too_old_uses_the_table() {
        assert_eq!(min_version(Cli::Claude), None);
        assert_eq!(min_version(Cli::Codex), Some(CliVersion(0, 136, 0)));
        assert_eq!(
            verdict(Cli::Codex, "codex-cli 0.135.9", Some(0), None),
            Verdict::TooOld {
                found: "0.135.9".into(),
                min: "0.136.0".into()
            }
        );
        assert_eq!(
            verdict(Cli::Codex, "codex-cli 0.136.0", Some(0), None),
            Verdict::Ok {
                version: "0.136.0".into()
            }
        );
        // An agent with no minimum is never too old.
        assert_eq!(
            verdict(Cli::Claude, "0.0.1", Some(0), None),
            Verdict::Ok {
                version: "0.0.1".into()
            }
        );
        let strict = verdict_with(
            Cli::Claude,
            Some(CliVersion(2, 0, 0)),
            "1.9.9",
            Some(0),
            None,
        );
        assert!(matches!(strict, Verdict::TooOld { .. }));
    }

    #[test]
    fn verdict_serializes_with_a_kind() {
        let json = serde_json::to_string(&Verdict::TooOld {
            found: "1.0.0".into(),
            min: "2.0.0".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"tooOld","found":"1.0.0","min":"2.0.0"}"#);
    }

    #[cfg(unix)]
    #[test]
    fn probe_of_a_missing_program_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let p = probe_version(&dir.path().join("nope"));
        assert!(p.spawn_error.is_some());
        assert_eq!(
            verdict(Cli::Claude, &p.output, p.exit, p.spawn_error.as_deref()),
            Verdict::NotInstalled
        );
    }
}
