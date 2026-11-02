use tempfile::TempDir;
use xdev_store::{AiWrite, Store, StoredDoc};

fn ai(path: &str, hash: &str, note: Option<&str>, time_ms: i64) -> AiWrite {
    AiWrite {
        path: path.to_owned(),
        hash: hash.to_owned(),
        note: note.map(str::to_owned),
        time_ms,
    }
}

fn row(path: &str, hash: &str) -> (String, String) {
    (path.to_owned(), hash.to_owned())
}

#[test]
fn record_replaces_by_path() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .record_ai_write(&ai("b.md", "h1", Some("first"), 1))
        .unwrap();
    store.record_ai_write(&ai("a.md", "h2", None, 2)).unwrap();
    store
        .record_ai_write(&ai("b.md", "h3", Some("second"), 3))
        .unwrap();
    assert_eq!(
        store.ai_writes().unwrap(),
        [
            ai("a.md", "h2", None, 2),
            ai("b.md", "h3", Some("second"), 3)
        ]
    );
}

#[test]
fn clear_keeps_newer_hash() {
    let mut store = Store::open_in_memory().unwrap();
    store.record_ai_write(&ai("a.md", "new", None, 1)).unwrap();
    store.record_ai_write(&ai("b.md", "h2", None, 2)).unwrap();
    store.record_ai_write(&ai("c.md", "h3", None, 3)).unwrap();
    // `a.md` was proposed again after the snapshot that saw `old`.
    store
        .clear_ai_writes(&[row("a.md", "old"), row("b.md", "h2"), row("zzz.md", "h")])
        .unwrap();
    assert_eq!(
        store.ai_writes().unwrap(),
        [ai("a.md", "new", None, 1), ai("c.md", "h3", None, 3)]
    );
    store.clear_ai_writes(&[]).unwrap();
    assert_eq!(store.ai_writes().unwrap().len(), 2);
}

/// The app and `xdev mcp` each hold their own connection to one index.
#[test]
fn ai_writes_seen_by_second_connection() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("index.db");
    let mut cli = Store::open(&db).unwrap();
    let mut app = Store::open(&db).unwrap();
    cli.record_ai_write(&ai("a.md", "h1", Some("why"), 7))
        .unwrap();
    assert_eq!(app.ai_writes().unwrap(), [ai("a.md", "h1", Some("why"), 7)]);
    app.clear_ai_writes(&[row("a.md", "h1")]).unwrap();
    assert!(cli.ai_writes().unwrap().is_empty());
}

#[test]
fn migration_keeps_docs() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join("index.db");
    let doc = StoredDoc {
        path: "a.md".to_owned(),
        title: "A".to_owned(),
        hash: "h1".to_owned(),
        size: 1,
        mtime_ms: 1,
    };
    {
        let mut store = Store::open(&db).unwrap();
        store.upsert(&doc, "body", &[]).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("DROP TABLE chunks; DROP TABLE ai_writes; PRAGMA user_version = 3;")
            .unwrap();
    }
    let store = Store::open(&db).unwrap();
    assert_eq!(store.docs().unwrap(), [doc]);
    assert!(store.ai_writes().unwrap().is_empty());
    let conn = rusqlite::Connection::open(&db).unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 5);
}
