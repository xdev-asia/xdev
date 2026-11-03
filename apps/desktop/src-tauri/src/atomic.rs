//! One way to replace a file whole: write a temp file beside it, flush it,
//! rename it over. A crash or a full disk leaves the old file or the new one,
//! never half of one.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Writes `bytes` to `path`, making its folder if missing. The temp name is
/// unique per call (`.<name>-<pid>-<n>.tmp`), so two writers never share
/// one; it is removed when the write fails.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    fs::create_dir_all(dir)?;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{}-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    // Flushed before the rename, so the name never points at bytes still in
    // the cache.
    let result = (|| {
        let mut f = File::create_new(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn writes_then_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("a.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(names(path.parent().unwrap()), ["a.json"]);
    }

    #[test]
    fn a_failed_rename_removes_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // A folder with a file in it cannot be renamed over on any platform.
        let path = dir.path().join("a.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"x").unwrap();
        assert!(write_atomic(&path, b"new").is_err());
        assert_eq!(names(dir.path()), ["a.json"]);
        assert_eq!(fs::read(path.join("keep")).unwrap(), b"x");
    }
}
