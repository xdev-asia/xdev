//! The last output of a PTY, saved by the service so a terminal that comes
//! back after the service died can show what it had.
//!
//! One file per PTY at `<service dir>/scrollback/<id>.bin`: raw bytes, the
//! last `SNAPSHOT_MAX`, cut after a newline so no line opens half way.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const SNAPSHOT_MAX: usize = 512 * 1024;
pub const DIR_MAX: u64 = 32 * 1024 * 1024;
pub const MAX_AGE: Duration = Duration::from_secs(14 * 24 * 3600);
pub const DIR_NAME: &str = "scrollback";

const EXT: &str = "bin";

/// An id that is safe as a file name: no separator, no dot, bounded.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn dir(service_dir: &Path) -> PathBuf {
    service_dir.join(DIR_NAME)
}

/// The file for `id`, or `None` when the id is not a safe name.
pub fn path(service_dir: &Path, id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| dir(service_dir).join(format!("{id}.{EXT}")))
}

fn bad_id() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "bad snapshot id")
}

/// The last `SNAPSHOT_MAX` bytes of `bytes`, starting after a newline when the
/// front was cut (and one is held).
fn cut(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let at = bytes.len() - max;
    if bytes[at - 1] == b'\n' {
        return &bytes[at..];
    }
    match bytes[at..].iter().position(|&b| b == b'\n') {
        Some(i) => &bytes[at + i + 1..],
        None => &bytes[at..],
    }
}

/// Saves the tail of `bytes` atomically: a temp file, then a rename.
pub fn write(service_dir: &Path, id: &str, bytes: &[u8]) -> io::Result<()> {
    let target = path(service_dir, id).ok_or_else(bad_id)?;
    let parent = dir(service_dir);
    fs::create_dir_all(&parent)?;
    let tmp = parent.join(format!("{id}.{EXT}.tmp"));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(cut(bytes, SNAPSHOT_MAX))?;
        f.sync_all()?;
        drop(f);
        // A reader holding the old file can make the first rename fail on
        // Windows; one retry is enough for a short read.
        match fs::rename(&tmp, &target) {
            Ok(()) => Ok(()),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(50));
                fs::rename(&tmp, &target)
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The saved bytes, at most `max`, cut after the first newline when the file
/// is longer. `None` when there is none or the id is not a safe name.
pub fn read(service_dir: &Path, id: &str, max: usize) -> io::Result<Option<Vec<u8>>> {
    let Some(file) = path(service_dir, id) else {
        return Ok(None);
    };
    let f = match fs::File::open(&file) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut buf = Vec::new();
    f.take(DIR_MAX).read_to_end(&mut buf)?;
    Ok(Some(cut(&buf, max).to_vec()))
}

/// Deletes the file for `id`; a missing one is fine.
pub fn remove(service_dir: &Path, id: &str) -> io::Result<()> {
    let Some(file) = path(service_dir, id) else {
        return Ok(());
    };
    match fs::remove_file(file) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Deletes the files older than `MAX_AGE`, then the oldest until the
/// directory is under `DIR_MAX`. Returns how many it deleted.
pub fn prune(service_dir: &Path, now: SystemTime) -> io::Result<usize> {
    let entries = match fs::read_dir(dir(service_dir)) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut files = Vec::new();
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let old = now.duration_since(at).is_ok_and(|age| age > MAX_AGE);
        if old {
            if fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        } else {
            files.push((at, meta.len(), entry.path()));
        }
    }
    files.sort_by_key(|f| f.0);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    for (_, len, file) in files {
        if total <= DIR_MAX {
            break;
        }
        if fs::remove_file(file).is_ok() {
            total -= len;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Deletes every snapshot, the directory too.
pub fn clear_all(service_dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir(service_dir)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_is_atomic_and_tail_cut_at_newline() {
        let tmp = tempfile::tempdir().unwrap();
        let mut bytes = b"head-without-newline".to_vec();
        bytes.extend(vec![b'x'; SNAPSHOT_MAX - 10]);
        bytes.extend(b"\nlast line\n");
        write(tmp.path(), "t1", &bytes).unwrap();
        let got = read(tmp.path(), "t1", usize::MAX).unwrap().unwrap();
        assert!(got.len() <= SNAPSHOT_MAX);
        assert!(got.ends_with(b"last line\n"));
        // The cut landed after a newline, not inside the long line.
        assert_eq!(got, b"last line\n");
        // No temp file is left.
        let names: Vec<_> = fs::read_dir(tmp.path().join(DIR_NAME))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["t1.bin".to_owned()]);
        // Small input is kept whole, and a rewrite replaces it.
        write(tmp.path(), "t1", b"a\nb").unwrap();
        assert_eq!(read(tmp.path(), "t1", 100).unwrap().unwrap(), b"a\nb");
    }

    #[test]
    fn bad_id_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        for id in ["", "../x", "a/b", "a.b", "a\\b", &"x".repeat(129)] {
            assert!(!valid_id(id), "{id}");
            assert!(path(tmp.path(), id).is_none());
            assert!(write(tmp.path(), id, b"x").is_err());
            assert_eq!(read(tmp.path(), id, 10).unwrap(), None);
        }
        assert!(valid_id("tab_1-A"));
        assert!(!tmp.path().join(DIR_NAME).exists());
    }

    #[test]
    fn prune_by_age_then_size() {
        let tmp = tempfile::tempdir().unwrap();
        for id in ["old", "a", "b", "c"] {
            write(tmp.path(), id, b"x\n").unwrap();
        }
        let now = SystemTime::now();
        let set = |id: &str, ago: Duration| {
            let f = fs::File::options()
                .write(true)
                .open(path(tmp.path(), id).unwrap())
                .unwrap();
            f.set_modified(now - ago).unwrap();
        };
        set("old", MAX_AGE + Duration::from_secs(3600));
        assert_eq!(prune(tmp.path(), now).unwrap(), 1);
        assert!(read(tmp.path(), "old", 10).unwrap().is_none());
        assert!(read(tmp.path(), "a", 10).unwrap().is_some());

        // Over the size cap: the oldest go first.
        let big = vec![b'y'; SNAPSHOT_MAX];
        let mut ids = Vec::new();
        for i in 0..(DIR_MAX as usize / SNAPSHOT_MAX + 2) {
            let id = format!("big{i}");
            write(tmp.path(), &id, &big).unwrap();
            set(&id, Duration::from_secs(1000 - i as u64));
            ids.push(id);
        }
        prune(tmp.path(), now).unwrap();
        assert!(read(tmp.path(), &ids[0], usize::MAX).unwrap().is_none());
        assert!(
            read(tmp.path(), ids.last().unwrap(), usize::MAX)
                .unwrap()
                .is_some()
        );
        let total: u64 = fs::read_dir(tmp.path().join(DIR_NAME))
            .unwrap()
            .map(|e| e.unwrap().metadata().unwrap().len())
            .sum();
        assert!(total <= DIR_MAX);
    }

    #[test]
    fn read_caps_at_max() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "t", b"one\ntwo\nthree\n").unwrap();
        // Last 8 bytes are "\nthree\n"+... cut lands after a newline.
        let got = read(tmp.path(), "t", 8).unwrap().unwrap();
        assert_eq!(got, b"three\n");
        assert_eq!(read(tmp.path(), "none", 8).unwrap(), None);
        remove(tmp.path(), "t").unwrap();
        remove(tmp.path(), "t").unwrap();
        assert_eq!(read(tmp.path(), "t", 8).unwrap(), None);
        write(tmp.path(), "t", b"x").unwrap();
        clear_all(tmp.path()).unwrap();
        assert!(!tmp.path().join(DIR_NAME).exists());
        clear_all(tmp.path()).unwrap();
    }
}
