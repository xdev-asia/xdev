use rusqlite::Connection;

/// Append only: entry `n` moves the schema from version `n` to `n + 1`.
const MIGRATIONS: &[&str] = &[
    // 1: docs and their full-text index.
    "CREATE TABLE docs (
       id INTEGER PRIMARY KEY,
       org_id TEXT NOT NULL DEFAULT 'local',
       workspace_id TEXT NOT NULL DEFAULT 'local',
       path TEXT NOT NULL,
       title TEXT NOT NULL,
       hash TEXT NOT NULL,
       size INTEGER NOT NULL,
       mtime_ms INTEGER NOT NULL,
       UNIQUE (org_id, workspace_id, path)
     );
     -- Stores its own copy of the text because snippet() needs it.
     CREATE VIRTUAL TABLE docs_fts USING fts5(
       title, body,
       tokenize='unicode61 remove_diacritics 2'
     ); -- rowid = docs.id",
    // 2: index folded text (see `query::fold`) and keep the original for
    // snippets. Clearing `docs` makes the next sync re-read every file.
    "DROP TABLE docs_fts;
     DELETE FROM docs;
     CREATE VIRTUAL TABLE docs_fts USING fts5(
       title, body, title_raw UNINDEXED, body_raw UNINDEXED,
       tokenize='unicode61 remove_diacritics 2'
     ); -- rowid = docs.id",
];

pub(crate) fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (index, sql) in MIGRATIONS
        .iter()
        .enumerate()
        .skip(usize::try_from(current).unwrap_or(0))
    {
        // The version bump shares the transaction, so a failed step leaves
        // the database at the previous version.
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }
}
