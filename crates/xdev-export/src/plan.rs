use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::render::{MARKER, OutFile};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    New,
    Changed,
    Unchanged,
    Foreign,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PlannedFile {
    pub path: String,
    pub status: FileStatus,
    /// On disk at plan time; `None` when missing, lossy when not UTF-8.
    pub old: Option<String>,
    pub new: String,
    /// blake3 hex of `new`, so a caller can confirm it writes what it showed.
    pub hash: String,
}

/// The UI translates `code()`, never the message.
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("stale")]
    Stale,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl ExportError {
    pub fn code(&self) -> &'static str {
        match self {
            ExportError::Stale => "stale",
            ExportError::Io(_) => "io",
        }
    }
}

pub fn plan(root: &Path, files: Vec<OutFile>) -> Result<Vec<PlannedFile>, ExportError> {
    files
        .into_iter()
        .map(|f| {
            let (status, old) = inspect(root, f.path, &f.content)?;
            Ok(PlannedFile {
                path: f.path.to_owned(),
                status,
                old,
                hash: blake3::hash(f.content.as_bytes()).to_hex().to_string(),
                new: f.content,
            })
        })
        .collect()
}

/// Writes the `new` and `changed` files and returns their paths in plan
/// order. Every file is checked against the plan before the first write, so
/// a disk change since the preview writes nothing.
pub fn write(root: &Path, plan: &[PlannedFile]) -> Result<Vec<String>, ExportError> {
    for p in plan {
        let (status, old) = inspect(root, &p.path, &p.new)?;
        if status != p.status || old != p.old {
            return Err(ExportError::Stale);
        }
    }
    let mut written = Vec::new();
    for p in plan {
        if matches!(p.status, FileStatus::New | FileStatus::Changed) {
            write_atomic(root, &p.path, &p.new)?;
            written.push(p.path.clone());
        }
    }
    Ok(written)
}

fn inspect(root: &Path, rel: &str, new: &str) -> io::Result<(FileStatus, Option<String>)> {
    let bytes = match fs::read(root.join(rel)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((FileStatus::New, None)),
        Err(e) => return Err(with_path(rel, e)),
    };
    Ok(match String::from_utf8(bytes) {
        Ok(text) if !is_generated(&text) => (FileStatus::Foreign, Some(text)),
        Ok(text) if text == new => (FileStatus::Unchanged, Some(text)),
        Ok(text) => (FileStatus::Changed, Some(text)),
        // xDev never writes non-UTF-8, so such a file is someone else's.
        Err(e) => (
            FileStatus::Foreign,
            Some(String::from_utf8_lossy(e.as_bytes()).into_owned()),
        ),
    })
}

/// The `.mdc` file must start with its own frontmatter, so the marker cannot
/// be required on the first line.
fn is_generated(text: &str) -> bool {
    text.trim_start_matches('\u{feff}')
        .lines()
        .take(5)
        .any(|line| line.trim() == MARKER)
}

fn write_atomic(root: &Path, rel: &str, content: &str) -> Result<(), ExportError> {
    let target = root.join(rel);
    let dir = target
        .parent()
        .ok_or_else(|| with_path(rel, io::ErrorKind::InvalidInput.into()))?;
    fs::create_dir_all(dir).map_err(|e| with_path(rel, e))?;

    // Same directory as the target so the rename never crosses a filesystem
    // and a reader never sees a half-written file.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".xdev-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = File::create_new(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(result.map_err(|e| with_path(rel, e))?)
}

fn with_path(rel: &str, e: io::Error) -> io::Error {
    io::Error::new(e.kind(), format!("{rel}: {e}"))
}
