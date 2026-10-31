//! SQLite storage: metadata, FTS5 and sqlite-vec indexes, migrations.

mod migrations;
mod query;

use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

pub use query::fts_query;
use query::{MARK_CLOSE, MARK_OPEN, fold, render_snippet, restore_snippet, strip_markers};

pub const NAME: &str = env!("CARGO_PKG_NAME");

/// Single-user tenancy until accounts exist; every row still carries both ids
/// so multi-tenant data needs no schema change.
const ORG_ID: &str = "local";
const WORKSPACE_ID: &str = "local";

/// Tokens of context on each side of a hit.
const SNIPPET_TOKENS: i64 = 12;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDoc {
    pub path: String,
    pub title: String,
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// A link as the doc wrote it; `kind` is `"wiki"` or `"md"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLink {
    pub kind: String,
    pub target: String,
}

/// `snippet` is HTML-escaped except for `<mark>` tags around hits.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        // WAL lets the CLI read while the desktop app writes; the timeout
        // covers the short moments when both write.
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        // The index is a rebuildable cache, so skipping an fsync per commit is
        // worth the risk of losing the last writes on power loss.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        migrations::migrate(&mut conn)?;
        Ok(Store { conn })
    }

    pub fn open_in_memory() -> Result<Store, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        migrations::migrate(&mut conn)?;
        Ok(Store { conn })
    }

    /// Sorted by path.
    pub fn docs(&self) -> Result<Vec<StoredDoc>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT path, title, hash, size, mtime_ms FROM docs
             WHERE org_id = ?1 AND workspace_id = ?2 ORDER BY path",
        )?;
        let rows = stmt.query_map(params![ORG_ID, WORKSPACE_ID], |r| {
            Ok(StoredDoc {
                path: r.get(0)?,
                title: r.get(1)?,
                hash: r.get(2)?,
                size: u64::try_from(r.get::<_, i64>(3)?).unwrap_or(0),
                mtime_ms: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// `links` replace the stored ones only when the hash changed, like the
    /// full-text row.
    pub fn upsert(
        &mut self,
        doc: &StoredDoc,
        body: &str,
        links: &[StoredLink],
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        let old_hash: Option<String> = tx
            .query_row(
                "SELECT hash FROM docs WHERE org_id = ?1 AND workspace_id = ?2 AND path = ?3",
                params![ORG_ID, WORKSPACE_ID, doc.path],
                |r| r.get(0),
            )
            .optional()?;
        let id: i64 = tx.query_row(
            "INSERT INTO docs (org_id, workspace_id, path, title, hash, size, mtime_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (org_id, workspace_id, path) DO UPDATE SET
               title = excluded.title, hash = excluded.hash,
               size = excluded.size, mtime_ms = excluded.mtime_ms
             RETURNING id",
            params![
                ORG_ID,
                WORKSPACE_ID,
                doc.path,
                doc.title,
                doc.hash,
                i64::try_from(doc.size).unwrap_or(i64::MAX),
                doc.mtime_ms
            ],
            |r| r.get(0),
        )?;
        // Same hash means same text (and so the same title): only the
        // metadata changed, so the full-text row is left alone.
        if old_hash.as_deref() != Some(doc.hash.as_str()) {
            tx.execute("DELETE FROM docs_fts WHERE rowid = ?1", [id])?;
            let title = strip_markers(&doc.title);
            let body = strip_markers(body);
            tx.execute(
                "INSERT INTO docs_fts (rowid, title, body, title_raw, body_raw)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, fold(&title), fold(&body), title, body],
            )?;
            tx.execute("DELETE FROM links WHERE doc_id = ?1", [id])?;
            let mut insert = tx
                .prepare("INSERT INTO links (doc_id, pos, kind, target) VALUES (?1, ?2, ?3, ?4)")?;
            for (pos, link) in links.iter().enumerate() {
                insert.execute(params![id, pos as i64, link.kind, link.target])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete(&mut self, path: &str) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        let id: Option<i64> = tx
            .query_row(
                "SELECT id FROM docs WHERE org_id = ?1 AND workspace_id = ?2 AND path = ?3",
                params![ORG_ID, WORKSPACE_ID, path],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = id {
            tx.execute("DELETE FROM docs_fts WHERE rowid = ?1", [id])?;
            tx.execute("DELETE FROM links WHERE doc_id = ?1", [id])?;
            tx.execute("DELETE FROM docs WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// `(source path, link)`, sorted by path, then by position in the doc.
    pub fn links(&self) -> Result<Vec<(String, StoredLink)>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT d.path, l.kind, l.target FROM links l JOIN docs d ON d.id = l.doc_id
             WHERE d.org_id = ?1 AND d.workspace_id = ?2 ORDER BY d.path, l.pos",
        )?;
        let rows = stmt.query_map(params![ORG_ID, WORKSPACE_ID], |r| {
            Ok((
                r.get(0)?,
                StoredLink {
                    kind: r.get(1)?,
                    target: r.get(2)?,
                },
            ))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Best match first. Input is plain words, never FTS5 syntax.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, StoreError> {
        let Some(fts) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let mut stmt = self.conn.prepare(
            "SELECT d.path, d.title,
                    snippet(docs_fts, 1, ?3, ?4, '', ?5),
                    snippet(docs_fts, 0, ?3, ?4, '', ?5),
                    docs_fts.body_raw, docs_fts.title_raw
             FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
             WHERE docs_fts MATCH ?1 AND d.org_id = ?6 AND d.workspace_id = ?7
             ORDER BY bm25(docs_fts)
             LIMIT ?2",
        )?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = stmt.query_map(
            params![
                fts,
                limit,
                MARK_OPEN.to_string(),
                MARK_CLOSE.to_string(),
                SNIPPET_TOKENS,
                ORG_ID,
                WORKSPACE_ID
            ],
            |r| {
                let body: String = r.get(2)?;
                let title: String = r.get(3)?;
                // A title-only match gives a body snippet without any hit,
                // so the title is shown instead.
                let (snippet, raw_column) =
                    if !body.contains(MARK_OPEN) && title.contains(MARK_OPEN) {
                        (title, 5)
                    } else {
                        (body, 4)
                    };
                let original: String = r.get(raw_column)?;
                let raw = restore_snippet(&snippet, &fold(&original), &original);
                Ok(SearchHit {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    snippet: render_snippet(&raw),
                })
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn name_matches_package() {
        assert_eq!(super::NAME, "xdev-store");
    }
}
