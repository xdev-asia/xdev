//! The version an installed agent CLI reports, so the status hooks offer it
//! only the events it knows (an unknown hook event stops claude's TUI on a
//! warning dialog at every launch).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

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
    let mut child = cmd.spawn().ok()?;
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
}
