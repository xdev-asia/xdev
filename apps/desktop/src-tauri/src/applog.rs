//! The app's own log: one JSON object per line in `<local>/logs/xdev.log`,
//! rotated at 5 MiB across three files. Every message is redacted before it
//! is written. A failure to log is never an error for the caller.

use crate::redact::redact_text;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const KEEP: usize = 3;
pub(crate) const FILE: &str = "xdev.log";

pub(crate) struct Rotating {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    home: Option<PathBuf>,
    // One writer at a time, so a line is never split by a rotation.
    gate: Mutex<()>,
}

/// The `n`th rotation of `path`: `xdev.log.1`, `xdev.log.2`.
pub(crate) fn rotated(path: &Path, n: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{n}"));
    PathBuf::from(name)
}

/// The log files that may exist, newest first.
pub(crate) fn files(dir: &Path) -> Vec<PathBuf> {
    let base = dir.join(FILE);
    let mut all = vec![base.clone()];
    all.extend((1..KEEP).map(|n| rotated(&base, n)));
    all
}

/// A rename can fail on Windows while another process (a virus scanner, a
/// log viewer) holds the file; a short retry rides that out.
fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut last = Ok(());
    for attempt in 0..3 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                last = Err(e);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            Err(e) => return Err(e),
        }
    }
    last
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Rotating {
    pub(crate) fn new(path: PathBuf, max_bytes: u64, keep: usize, home: Option<PathBuf>) -> Self {
        Self {
            path,
            max_bytes,
            keep: keep.max(1),
            home,
            gate: Mutex::new(()),
        }
    }

    fn rotate(&self) -> io::Result<()> {
        // `keep` files in all: the live one and `keep - 1` rotations.
        let _ = fs::remove_file(rotated(&self.path, self.keep - 1));
        for n in (1..self.keep.saturating_sub(1)).rev() {
            let from = rotated(&self.path, n);
            if from.exists() {
                rename_retry(&from, &rotated(&self.path, n + 1))?;
            }
        }
        if self.keep > 1 {
            rename_retry(&self.path, &rotated(&self.path, 1))
        } else {
            fs::remove_file(&self.path)
        }
    }

    /// Appends one redacted line. The file is opened and closed per call so
    /// rotation can rename it on Windows.
    pub(crate) fn write(&self, level: &str, target: &str, msg: &str) -> io::Result<()> {
        let line = serde_json::json!({
            "ts": now_ms(),
            "level": level,
            "target": target,
            "msg": redact_text(msg, self.home.as_deref()),
        })
        .to_string()
            + "\n";
        let _guard = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size + line.len() as u64 > self.max_bytes {
            // A rename that stays blocked must not stop logging for the rest
            // of the session: empty the live file instead, or append anyway.
            if self.rotate().is_err() {
                let _ = fs::write(&self.path, b"");
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // The log can hold paths and messages: owner only.
            options.mode(0o600);
        }
        let mut f = options.open(&self.path)?;
        f.write_all(line.as_bytes())
    }
}

static LOG: OnceLock<Rotating> = OnceLock::new();

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Starts logging into `<local>/logs`. Without a folder, lines only go to
/// stderr.
pub(crate) fn init(local: Option<&Path>) {
    if let Some(local) = local {
        let _ = LOG.set(Rotating::new(
            local.join("logs").join(FILE),
            MAX_BYTES,
            KEEP,
            home_dir(),
        ));
    }
}

fn log(level: &str, target: &str, msg: &str) {
    if let Some(l) = LOG.get() {
        // Best effort: a full disk must not turn into a second problem.
        let _ = l.write(level, target, msg);
    }
}

pub(crate) fn info(target: &str, msg: &str) {
    log("info", target, msg);
}

pub(crate) fn warn(target: &str, msg: &str) {
    eprintln!("{target}: {msg}");
    log("warn", target, msg);
}

pub(crate) fn error(target: &str, msg: &str) {
    eprintln!("{target}: {msg}");
    log("error", target, msg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dirs::long_temp_dir;

    fn lines(path: &Path) -> Vec<serde_json::Value> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn appends_ndjson_lines() {
        let dir = long_temp_dir("applog");
        let log = Rotating::new(dir.path().join("logs").join(FILE), MAX_BYTES, KEEP, None);
        log.write("warn", "ptyd", "one").unwrap();
        log.write("error", "updater", "two").unwrap();
        let got = lines(&dir.path().join("logs").join(FILE));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["level"], "warn");
        assert_eq!(got[0]["target"], "ptyd");
        assert_eq!(got[0]["msg"], "one");
        assert!(got[0]["ts"].as_u64().unwrap() > 0);
        assert_eq!(got[1]["msg"], "two");
    }

    #[test]
    fn rotates_at_the_cap_and_drops_the_oldest() {
        let dir = long_temp_dir("applog");
        let path = dir.path().join(FILE);
        // Each line is well over 20 bytes, so every write after the first
        // overflows a 120 byte cap quickly.
        let log = Rotating::new(path.clone(), 120, 3, None);
        for i in 0..12 {
            log.write("info", "t", &format!("message number {i}"))
                .unwrap();
        }
        assert!(path.exists());
        assert!(rotated(&path, 1).exists());
        assert!(rotated(&path, 2).exists());
        assert!(!rotated(&path, 3).exists());
        // Newest line is in the live file; older ones moved down.
        let live = lines(&path);
        assert_eq!(live.last().unwrap()["msg"], "message number 11");
        let oldest_kept = lines(&rotated(&path, 2));
        assert!(oldest_kept[0]["msg"].as_str().unwrap() != "message number 0");
        for file in [&path, &rotated(&path, 1), &rotated(&path, 2)] {
            assert!(fs::metadata(file).unwrap().len() <= 120);
        }
    }

    #[test]
    fn a_blocked_rotation_does_not_stop_logging() {
        let dir = long_temp_dir("applog");
        let path = dir.path().join("x.log");
        // A folder where the first rotation goes: the rename fails.
        fs::create_dir(rotated(&path, 1)).unwrap();
        let log = Rotating::new(path.clone(), 100, 2, None);
        for i in 0..6 {
            log.write("info", "t", &format!("message number {i} with padding"))
                .unwrap();
        }
        let got = lines(&path);
        assert!(!got.is_empty());
        assert_eq!(got.last().unwrap()["msg"], "message number 5 with padding");
    }

    #[cfg(unix)]
    #[test]
    fn the_log_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = long_temp_dir("applog");
        let path = dir.path().join("x.log");
        Rotating::new(path.clone(), 1000, 2, None)
            .write("info", "t", "m")
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn redacts_before_writing() {
        let dir = long_temp_dir("applog");
        let path = dir.path().join(FILE);
        let home = dir.path().join("home");
        let log = Rotating::new(path.clone(), MAX_BYTES, KEEP, Some(home.clone()));
        let msg = format!(
            "token=abc123 opened {} sk-ant-abcdefghijk",
            home.join("x").display()
        );
        log.write("warn", "t", &msg).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("abc123"));
        assert!(!raw.contains("sk-ant-abcdefghijk"));
        assert!(!raw.contains(&*home.to_string_lossy().replace('\\', "\\\\")));
        assert!(raw.contains("[redacted"));
    }

    #[test]
    fn a_missing_folder_is_made_and_a_bad_one_does_not_panic() {
        let dir = long_temp_dir("applog");
        let log = Rotating::new(dir.path().join("a").join("b").join(FILE), 100, 3, None);
        log.write("info", "t", "x").unwrap();
        // The parent is a file: the write fails with an error, never a panic.
        let blocker = dir.path().join("file");
        fs::write(&blocker, "x").unwrap();
        let bad = Rotating::new(blocker.join(FILE), 100, 3, None);
        assert!(bad.write("info", "t", "x").is_err());
        // The free functions are silent without `init`.
        warn("t", "no log set up");
    }
}
