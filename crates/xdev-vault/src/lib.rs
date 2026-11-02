//! Reads and writes Markdown files, parses frontmatter, watches the vault and hashes content.

mod frontmatter;
mod links;
mod path;
mod title;
mod watch;

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;

pub use frontmatter::{Frontmatter, Target, parse_frontmatter};
pub use links::{Link, LinkKind, Resolver, parse_links};
pub use title::extract_title;
pub use watch::VaultWatcher;

pub const NAME: &str = env!("CARGO_PKG_NAME");

/// Larger files are listed but never read, so one huge file cannot stall the
/// editor or bloat the index.
pub const MAX_DOC_BYTES: u64 = 5 * 1024 * 1024;

/// Each variant carries the vault-relative path (or the input) as detail. The
/// UI translates `code()`, never the message.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("outside vault: {0}")]
    OutsideVault(String),
    #[error("not utf-8: {0}")]
    NotUtf8(String),
    #[error("too large: {0}")]
    TooLarge(String),
    #[error("already exists: {0}")]
    Exists(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl VaultError {
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::NotFound(_) => "not_found",
            VaultError::OutsideVault(_) => "outside_vault",
            VaultError::NotUtf8(_) => "not_utf8",
            VaultError::TooLarge(_) => "too_large",
            VaultError::Exists(_) => "exists",
            VaultError::Io(_) => "io",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocMeta {
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

pub struct Vault {
    root: PathBuf,
}

impl Vault {
    pub fn open(root: impl AsRef<Path>) -> Result<Vault, VaultError> {
        let given = root.as_ref();
        let not_found = || VaultError::NotFound(given.display().to_string());
        // Canonical root makes the containment check and the vault id
        // independent of how the caller spelled the path.
        let root = fs::canonicalize(given).map_err(|_| not_found())?;
        if !root.is_dir() {
            return Err(not_found());
        }
        Ok(Vault { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn id(&self) -> String {
        let hash = content_hash(self.root.to_string_lossy().as_bytes());
        hash[..16].to_owned()
    }

    pub fn list(&self) -> Result<Vec<DocMeta>, VaultError> {
        let walker = WalkBuilder::new(&self.root)
            // Dot-folders such as `.github/` hold real docs; only the
            // built-in names below are always skipped.
            .hidden(false)
            .git_ignore(true)
            .require_git(false)
            .filter_entry(|e| {
                e.depth() == 0
                    || !e.file_type().is_some_and(|t| t.is_dir())
                    || !path::is_builtin_skip(&e.file_name().to_string_lossy())
            })
            .build();

        // A missing or unreadable root must fail loudly: an empty list would
        // make the caller drop the whole index.
        fs::read_dir(&self.root).map_err(|e| path::io_error(&self.root.to_string_lossy(), e))?;

        let mut docs = Vec::new();
        for entry in walker {
            // One unreadable subfolder or a file deleted mid-walk should not
            // hide the rest of the vault.
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) || !path::is_md(entry.path()) {
                continue;
            }
            // A name that is not valid Unicode cannot cross the string-based
            // API, so it is left out rather than mangled.
            let Some(rel) = path::to_rel(&self.root, entry.path()) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            docs.push(DocMeta {
                path: rel,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
            });
        }
        docs.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(docs)
    }

    pub fn resolve(&self, rel: &str) -> Result<PathBuf, VaultError> {
        path::resolve(&self.root, rel)
    }

    pub fn read(&self, rel: &str) -> Result<String, VaultError> {
        let full = self.resolve(rel)?;
        let file = File::open(&full).map_err(|e| path::io_error(rel, e))?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(VaultError::NotFound(rel.to_owned()));
        }
        if meta.len() > MAX_DOC_BYTES {
            return Err(VaultError::TooLarge(rel.to_owned()));
        }
        // The file may grow after the size check, so the read is capped too.
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(MAX_DOC_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_DOC_BYTES {
            return Err(VaultError::TooLarge(rel.to_owned()));
        }
        String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8(rel.to_owned()))
    }

    pub fn write(&self, rel: &str, content: &str) -> Result<(), VaultError> {
        // The vault only holds docs; refusing other names keeps the UI from
        // being used to drop arbitrary files into the user's folder.
        if !path::is_md(Path::new(rel)) {
            return Err(VaultError::OutsideVault(rel.to_owned()));
        }
        if content.len() as u64 > MAX_DOC_BYTES {
            return Err(VaultError::TooLarge(rel.to_owned()));
        }
        let target = self.resolve(rel)?;
        let dir = target
            .parent()
            .ok_or_else(|| VaultError::OutsideVault(rel.to_owned()))?;

        // Same directory as the target so the rename never crosses a
        // filesystem; the suffix keeps it out of `list` and the watcher.
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
        result.map_err(|e| path::io_error(rel, e))
    }

    /// Like `write`, but never replaces a file: the name is claimed with
    /// `create_new`, so a doc made elsewhere a moment earlier still wins.
    pub fn create(&self, rel: &str, content: &str) -> Result<(), VaultError> {
        if !path::is_md(Path::new(rel)) {
            return Err(VaultError::OutsideVault(rel.to_owned()));
        }
        if content.len() as u64 > MAX_DOC_BYTES {
            return Err(VaultError::TooLarge(rel.to_owned()));
        }
        let target = self.resolve(rel)?;
        let mut file = File::create_new(&target).map_err(|e| match e.kind() {
            io::ErrorKind::AlreadyExists => VaultError::Exists(rel.to_owned()),
            _ => path::io_error(rel, e),
        })?;
        let result = file
            .write_all(content.as_bytes())
            .and_then(|()| file.sync_all());
        if let Err(e) = result {
            drop(file);
            // The file is ours alone; a half-written doc would look real.
            let _ = fs::remove_file(&target);
            return Err(path::io_error(rel, e));
        }
        Ok(())
    }

    pub fn remove(&self, rel: &str) -> Result<(), VaultError> {
        if !path::is_md(Path::new(rel)) {
            return Err(VaultError::OutsideVault(rel.to_owned()));
        }
        self.resolve(rel)?;
        // `resolve` follows a symlink to check where it points; removing the
        // name itself deletes the link, never the file behind it.
        let target = self.root.join(rel);
        fs::remove_file(&target).map_err(|e| path::io_error(rel, e))
    }

    pub fn watch(
        &self,
        on_change: impl Fn(Vec<String>) + Send + 'static,
    ) -> Result<VaultWatcher, VaultError> {
        watch::start(self.root.clone(), on_change)
    }
}

/// Whether a vault-relative path is a doc `list` would show, leaving
/// `.gitignore` aside.
pub fn is_doc_path(rel: &str) -> bool {
    path::is_md(Path::new(rel)) && !path::in_builtin_dir(rel)
}

pub fn content_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_matches_package() {
        assert_eq!(NAME, "xdev-vault");
    }

    #[test]
    fn codes_are_stable() {
        let cases = [
            (VaultError::NotFound(String::new()), "not_found"),
            (VaultError::OutsideVault(String::new()), "outside_vault"),
            (VaultError::NotUtf8(String::new()), "not_utf8"),
            (VaultError::TooLarge(String::new()), "too_large"),
            (VaultError::Exists(String::new()), "exists"),
            (VaultError::Io(io::Error::other("x")), "io"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
        }
    }
}
