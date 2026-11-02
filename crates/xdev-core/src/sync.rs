use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use xdev_store::{SearchHit, Store, StoredDoc, StoredLink};
use xdev_vault::{MAX_DOC_BYTES, Vault, VaultError, content_hash, extract_title, parse_links};

use crate::CoreError;

/// Why a listed file is not indexed. Serialized as the UI's `skipped` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    TooLarge,
    NotUtf8,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct DocEntry {
    pub path: String,
    pub title: String,
    pub size: u64,
    pub skipped: Option<Skip>,
}

/// Kept outside the vault so the user's folder stays clean. Under the local
/// dir: an index is rebuilt from the vault, so it has no reason to roam.
pub fn index_path(local_dir: &Path, vault: &Vault) -> PathBuf {
    local_dir.join("vaults").join(vault.id()).join("index.db")
}

/// Brings the index in line with the files on disk and returns every listed
/// doc, sorted by path. Only files whose size or mtime changed are read.
pub fn sync_vault(vault: &Vault, store: &mut Store) -> Result<Vec<DocEntry>, CoreError> {
    let files = vault.list()?;
    let stored: HashMap<String, StoredDoc> = store
        .docs()?
        .into_iter()
        .map(|d| (d.path.clone(), d))
        .collect();
    let mut indexed = HashSet::new();
    let mut entries = Vec::with_capacity(files.len());

    for meta in files {
        let skipped = |skip| DocEntry {
            title: extract_title(&meta.path, ""),
            path: meta.path.clone(),
            size: meta.size,
            skipped: Some(skip),
        };

        if let Some(prev) = stored.get(&meta.path)
            && prev.size == meta.size
            && prev.mtime_ms == meta.mtime_ms
        {
            indexed.insert(meta.path.clone());
            entries.push(DocEntry {
                path: meta.path,
                title: prev.title.clone(),
                size: meta.size,
                skipped: None,
            });
            continue;
        }
        if meta.size > MAX_DOC_BYTES {
            entries.push(skipped(Skip::TooLarge));
            continue;
        }

        let content = match vault.read(&meta.path) {
            Ok(content) => content,
            Err(VaultError::TooLarge(_)) => {
                entries.push(skipped(Skip::TooLarge));
                continue;
            }
            Err(VaultError::NotUtf8(_)) => {
                entries.push(skipped(Skip::NotUtf8));
                continue;
            }
            // Deleted between listing and reading; the next sync settles it.
            Err(VaultError::NotFound(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let doc = StoredDoc {
            title: extract_title(&meta.path, &content),
            hash: content_hash(content.as_bytes()),
            path: meta.path,
            size: meta.size,
            mtime_ms: meta.mtime_ms,
        };
        let links: Vec<StoredLink> = parse_links(&content)
            .into_iter()
            .map(|l| StoredLink {
                kind: l.kind.as_str().to_owned(),
                target: l.target,
            })
            .collect();
        // The store skips the full-text and links rewrite when the hash is
        // unchanged.
        store.upsert(&doc, &content, &links)?;
        indexed.insert(doc.path.clone());
        entries.push(DocEntry {
            path: doc.path,
            title: doc.title,
            size: doc.size,
            skipped: None,
        });
    }

    // Covers deleted files and files that became skipped.
    for path in stored.keys().filter(|p| !indexed.contains(*p)) {
        store.delete(path)?;
    }
    Ok(entries)
}

pub fn search(store: &Store, query: &str, limit: usize) -> Result<Vec<SearchHit>, CoreError> {
    Ok(store.search(query, limit)?)
}
