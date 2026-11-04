//! A full-text index of agent conversations. It lives in its own SQLite
//! file, apart from the doc store, because the text of a conversation is
//! private: the file is written only after the person agrees, and deleted
//! whole when they clear it. Everything in it can be read again from the CLI
//! logs, so a lost file costs a rebuild and nothing else.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, params};

use crate::StoreError;
use crate::query::{
    MARK_CLOSE, MARK_OPEN, fold, fts_query, render_snippet, restore_snippet, strip_markers,
};

/// Tokens of context on each side of a hit.
const SNIPPET_TOKENS: i64 = 16;
/// Hits read per wanted session: one session may hold many matching messages.
const HITS_PER_SESSION: usize = 50;
const HITS_MAX: usize = 10_000;

/// Append only: entry `n` moves the schema from version `n` to `n + 1`.
const MIGRATIONS: &[&str] = &["CREATE TABLE msgs (
       id INTEGER PRIMARY KEY,
       session_key TEXT NOT NULL,
       file TEXT NOT NULL,
       role INTEGER NOT NULL,
       at INTEGER NOT NULL
     );
     CREATE INDEX msgs_session ON msgs (session_key);
     CREATE INDEX msgs_file ON msgs (file);
     -- Stores its own copy of the text because snippet() needs it; the
     -- indexed column is folded (see `query::fold`).
     CREATE VIRTUAL TABLE msgs_fts USING fts5(
       body, body_raw UNINDEXED,
       tokenize='unicode61 remove_diacritics 2'
     ); -- rowid = msgs.id
     -- Where the reader stopped in each log, as the caller wrote it.
     CREATE TABLE files (file TEXT PRIMARY KEY, mark TEXT NOT NULL);
     CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);"];

/// One message to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredText {
    pub file: String,
    pub session_key: String,
    /// 0 for the person, 1 for the agent.
    pub role: u8,
    pub text: String,
    pub at: i64,
}

/// `snippet` is HTML-escaped except for `<mark>` tags around hits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTextHit {
    pub session_key: String,
    pub snippet: String,
}

pub struct SessionTextIndex {
    conn: Connection,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (index, sql) in MIGRATIONS
        .iter()
        .enumerate()
        .skip(usize::try_from(current).unwrap_or(0))
    {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

impl SessionTextIndex {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// Opens an index that is already there for reading only: it never
    /// creates the file or its folder, never migrates, and `None` means there
    /// is no file. For a status read, which must not bring back what a clear
    /// deleted nor hold the file open against its removal.
    pub fn open_read_only(path: &Path) -> Result<Option<Self>, StoreError> {
        if !path.is_file() {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(Some(Self { conn }))
    }

    /// `(file, mark json)` of every log read so far.
    pub fn marks(&self) -> Result<Vec<(String, String)>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT file, mark FROM files")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One transaction: drops the texts of the `reset` and `gone` files (and
    /// the marks of the gone ones), adds `events`, and saves `marks`.
    pub fn apply(
        &mut self,
        events: Vec<StoredText>,
        marks: &[(String, String)],
        reset: &[String],
        gone: &[String],
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        for file in reset.iter().chain(gone) {
            drop_file(&tx, file)?;
        }
        for file in gone {
            tx.execute("DELETE FROM files WHERE file = ?1", [file])?;
        }
        {
            let mut add = tx.prepare(
                "INSERT INTO msgs (session_key, file, role, at) VALUES (?1, ?2, ?3, ?4)",
            )?;
            let mut fts =
                tx.prepare("INSERT INTO msgs_fts (rowid, body, body_raw) VALUES (?1, ?2, ?3)")?;
            for e in &events {
                add.execute(params![e.session_key, e.file, e.role, e.at])?;
                let id = tx.last_insert_rowid();
                let raw = strip_markers(&e.text);
                fts.execute(params![id, fold(&raw), raw.as_ref()])?;
            }
        }
        for (file, mark) in marks {
            tx.execute(
                "INSERT INTO files (file, mark) VALUES (?1, ?2)
                 ON CONFLICT (file) DO UPDATE SET mark = excluded.mark",
                params![file, mark],
            )?;
        }
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('updated_at', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Drops every text whose session is not in `keep`.
    pub fn retain_sessions(&mut self, keep: &HashSet<String>) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        let stale: Vec<String> = {
            let mut stmt = tx.prepare("SELECT DISTINCT session_key FROM msgs")?;
            let all = stmt.query_map([], |r| r.get::<_, String>(0))?;
            all.filter(|k| k.as_ref().map_or(true, |k| !keep.contains(k)))
                .collect::<Result<_, _>>()?
        };
        for key in &stale {
            tx.execute(
                "DELETE FROM msgs_fts WHERE rowid IN
                   (SELECT id FROM msgs WHERE session_key = ?1)",
                [key],
            )?;
            tx.execute("DELETE FROM msgs WHERE session_key = ?1", [key])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// `(rowid, session key)` of the best message of each session, best first.
    /// Ranks without computing any snippet, so a common word costs one pass
    /// over the matches and no text work.
    fn best_rows(&self, query: &str, limit: usize) -> Result<Vec<(i64, String)>, StoreError> {
        let Some(fts) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let mut stmt = self.conn.prepare(
            "SELECT msgs_fts.rowid, m.session_key
             FROM msgs_fts JOIN msgs m ON m.id = msgs_fts.rowid
             WHERE msgs_fts MATCH ?1
             ORDER BY bm25(msgs_fts)
             LIMIT ?2",
        )?;
        let reads =
            i64::try_from(limit.saturating_mul(HITS_PER_SESSION).min(HITS_MAX)).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![fts, reads], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for row in rows {
            let (id, key): (i64, String) = row?;
            if out.len() < limit && seen.insert(key.clone()) {
                out.push((id, key));
            }
        }
        Ok(out)
    }

    /// The best hit of each session, best first. The snippet is computed only
    /// for the one message kept per session.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SessionTextHit>, StoreError> {
        let best = self.best_rows(query, limit)?;
        let Some(fts) = fts_query(query).filter(|_| !best.is_empty()) else {
            return Ok(Vec::new());
        };
        let ids = best
            .iter()
            .map(|(id, _)| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        // The ids are numbers from the query above, never text from outside.
        let mut stmt = self.conn.prepare(&format!(
            "SELECT rowid, snippet(msgs_fts, 0, ?2, ?3, '', ?4), body_raw
             FROM msgs_fts
             WHERE msgs_fts MATCH ?1 AND rowid IN ({ids})"
        ))?;
        let mut snippets: std::collections::HashMap<i64, String> = stmt
            .query_map(
                params![
                    fts,
                    MARK_OPEN.to_string(),
                    MARK_CLOSE.to_string(),
                    SNIPPET_TOKENS
                ],
                |r| {
                    let id: i64 = r.get(0)?;
                    let snippet: String = r.get(1)?;
                    let original: String = r.get(2)?;
                    let raw = restore_snippet(&snippet, &fold(&original), &original);
                    Ok((id, render_snippet(&raw)))
                },
            )?
            .collect::<Result<_, _>>()?;
        Ok(best
            .into_iter()
            .filter_map(|(id, session_key)| {
                Some(SessionTextHit {
                    session_key,
                    snippet: snippets.remove(&id)?,
                })
            })
            .collect())
    }

    /// `(sessions, messages)` held.
    pub fn counts(&self) -> Result<(u32, u32), StoreError> {
        let (sessions, messages): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(DISTINCT session_key), COUNT(*) FROM msgs",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok((
            u32::try_from(sessions).unwrap_or(u32::MAX),
            u32::try_from(messages).unwrap_or(u32::MAX),
        ))
    }

    /// Unix ms of the last `apply`; `None` before the first.
    pub fn updated_at(&self) -> Result<Option<i64>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM meta WHERE key = 'updated_at'")?;
        let mut rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        Ok(rows.next().transpose()?)
    }
}

fn drop_file(tx: &rusqlite::Transaction<'_>, file: &str) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM msgs_fts WHERE rowid IN (SELECT id FROM msgs WHERE file = ?1)",
        [file],
    )?;
    tx.execute("DELETE FROM msgs WHERE file = ?1", [file])?;
    Ok(())
}

/// Deletes the index file and its `-wal` and `-shm` side files. A file that
/// is not there is fine.
pub fn remove_session_index(path: &Path) -> Result<(), StoreError> {
    let side = |suffix: &str| {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    for file in [path.to_path_buf(), side("-wal"), side("-shm")] {
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(file: &str, session: &str, body: &str) -> StoredText {
        StoredText {
            file: file.into(),
            session_key: session.into(),
            role: 0,
            text: body.into(),
            at: 1,
        }
    }

    fn open() -> (tempfile::TempDir, SessionTextIndex) {
        let dir = tempfile::tempdir().unwrap();
        let index = SessionTextIndex::open(&dir.path().join("kit").join("s.sqlite")).unwrap();
        (dir, index)
    }

    #[test]
    fn apply_then_search_gives_one_hit_per_session() {
        let (_dir, mut index) = open();
        index
            .apply(
                vec![
                    text("a", "h:1", "the parser fails on windows paths"),
                    text("a", "h:1", "parser parser parser everywhere"),
                    text("b", "h:2", "nothing here about it"),
                    text("c", "h:3", "a different parser bug <b>bold</b>"),
                ],
                &[("a".into(), "{}".into())],
                &[],
                &[],
            )
            .unwrap();
        let hits = index.search("parser", 10).unwrap();
        let keys: HashSet<_> = hits.iter().map(|h| h.session_key.as_str()).collect();
        assert_eq!(hits.len(), 2);
        assert_eq!(keys, HashSet::from(["h:1", "h:3"]));
        assert!(hits.iter().all(|h| h.snippet.contains("<mark>")));
        assert_eq!(index.counts().unwrap(), (3, 4));
        assert!(index.updated_at().unwrap().is_some());
        assert_eq!(index.marks().unwrap(), vec![("a".into(), "{}".into())]);
        assert_eq!(index.search("parser", 1).unwrap().len(), 1);
    }

    #[test]
    fn snippets_escape_the_text() {
        let (_dir, mut index) = open();
        index
            .apply(
                vec![text("a", "h:1", "see <script>x</script> parser")],
                &[],
                &[],
                &[],
            )
            .unwrap();
        let hit = &index.search("parser", 5).unwrap()[0];
        assert!(hit.snippet.contains("&lt;script&gt;"));
        assert!(!hit.snippet.contains("<script>"));
    }

    #[test]
    fn diacritics_and_d_stroke_fold() {
        let (_dir, mut index) = open();
        index
            .apply(vec![text("a", "h:1", "Đường dẫn của tệp")], &[], &[], &[])
            .unwrap();
        assert_eq!(index.search("duong dan", 5).unwrap().len(), 1);
        let hit = &index.search("duong", 5).unwrap()[0];
        assert!(
            hit.snippet.contains("<mark>Đường</mark>"),
            "{}",
            hit.snippet
        );
    }

    #[test]
    fn fts_operators_in_the_input_are_inert() {
        let (_dir, mut index) = open();
        index
            .apply(vec![text("a", "h:1", "alpha beta")], &[], &[], &[])
            .unwrap();
        for q in [
            "alpha OR",
            "\"alpha",
            "NEAR(alpha beta)",
            "alpha*",
            "-alpha",
            "col:alpha",
            "(",
        ] {
            assert!(index.search(q, 5).is_ok(), "{q}");
        }
        assert!(index.search("alpha OR zzz", 5).unwrap().is_empty());
        assert!(index.search("   ", 5).unwrap().is_empty());
    }

    #[test]
    fn retain_sessions_drops_the_rest() {
        let (_dir, mut index) = open();
        index
            .apply(
                vec![text("a", "h:1", "keep me"), text("b", "h:2", "drop me")],
                &[],
                &[],
                &[],
            )
            .unwrap();
        index
            .retain_sessions(&HashSet::from(["h:1".to_string()]))
            .unwrap();
        assert_eq!(index.counts().unwrap(), (1, 1));
        assert!(index.search("drop", 5).unwrap().is_empty());
        assert_eq!(index.search("keep", 5).unwrap().len(), 1);
    }

    #[test]
    fn reset_and_gone_delete_a_files_rows() {
        let (_dir, mut index) = open();
        index
            .apply(
                vec![
                    text("a", "h:1", "old words"),
                    text("b", "h:2", "other words"),
                ],
                &[("a".into(), "1".into()), ("b".into(), "1".into())],
                &[],
                &[],
            )
            .unwrap();
        index
            .apply(
                vec![text("a", "h:1", "new words")],
                &[("a".into(), "2".into())],
                &["a".into()],
                &[],
            )
            .unwrap();
        assert!(index.search("old", 5).unwrap().is_empty());
        assert_eq!(index.search("new", 5).unwrap().len(), 1);
        index.apply(vec![], &[], &[], &["b".into()]).unwrap();
        assert!(index.search("other", 5).unwrap().is_empty());
        assert_eq!(index.marks().unwrap(), vec![("a".into(), "2".into())]);
    }

    #[test]
    fn remove_session_index_takes_the_side_files_and_forgives_a_missing_one() {
        let (dir, mut index) = open();
        index
            .apply(vec![text("a", "h:1", "words")], &[], &[], &[])
            .unwrap();
        let path = dir.path().join("kit").join("s.sqlite");
        assert!(path.exists());
        drop(index);
        remove_session_index(&path).unwrap();
        assert!(!path.exists());
        assert!(!path.with_extension("sqlite-wal").exists());
        remove_session_index(&path).unwrap();
    }

    #[test]
    fn a_read_only_open_never_creates_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kit").join("s.sqlite");
        assert!(SessionTextIndex::open_read_only(&path).unwrap().is_none());
        assert!(!path.exists());
        assert!(!dir.path().join("kit").exists());
        let mut index = SessionTextIndex::open(&path).unwrap();
        index
            .apply(vec![text("a", "h:1", "words")], &[], &[], &[])
            .unwrap();
        let read = SessionTextIndex::open_read_only(&path).unwrap().unwrap();
        assert_eq!(read.counts().unwrap(), (1, 1));
        assert!(read.updated_at().unwrap().is_some());
    }

    #[test]
    fn the_ranking_pass_keeps_the_best_message_of_each_session_without_snippets() {
        let (_dir, mut index) = open();
        index
            .apply(
                vec![
                    text("a", "h:1", "parser and a long tail of other words here"),
                    text("a", "h:1", "parser parser parser"),
                    text("b", "h:2", "the parser"),
                ],
                &[],
                &[],
                &[],
            )
            .unwrap();
        let rows = index.best_rows("parser", 10).unwrap();
        let keys: Vec<_> = rows.iter().map(|(_, k)| k.as_str()).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(keys.iter().collect::<HashSet<_>>().len(), 2);
        assert_eq!(index.best_rows("parser", 1).unwrap().len(), 1);
        assert!(index.best_rows("zzz", 5).unwrap().is_empty());
        // The best message of h:1 is the repeated one (rowid 2).
        assert!(rows.iter().any(|(id, k)| k == "h:1" && *id == 2));
    }
}
