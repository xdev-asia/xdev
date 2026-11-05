//! The SQLite store: one connection, schema versions in `PRAGMA user_version`.
//!
//! The app owns the only connection (behind a mutex); the CLI never opens the
//! file. The verbs live in the sibling modules as `impl Store` blocks.

use std::cell::Cell;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::OrchError;
use crate::ids::new_id;
use crate::model::{Dispatch, Gate, Message, Run, Task, Worker};

/// The schema version this build writes.
pub const SCHEMA_VERSION: i32 = 2;

const SCHEMA_V1: &str = "
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    coordinator_tab TEXT,
    created_ms INTEGER NOT NULL
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    title TEXT,
    spec TEXT NOT NULL,
    deps TEXT NOT NULL DEFAULT '[]',
    parent TEXT,
    status TEXT NOT NULL,
    result TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
);
CREATE INDEX tasks_run ON tasks (run_id);
CREATE TABLE dispatches (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 1,
    retry_of TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    parent_dispatch TEXT
);
CREATE INDEX dispatches_task ON dispatches (task_id);
CREATE TABLE workers (
    dispatch_id TEXT PRIMARY KEY,
    tab TEXT,
    worktree TEXT NOT NULL,
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    failed_stage TEXT,
    last_error TEXT,
    kept INTEGER NOT NULL DEFAULT 0,
    closes_at_ms INTEGER,
    released INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    close_asked_ms INTEGER,
    finished_ms INTEGER
);
CREATE INDEX workers_tab ON workers (tab);
CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    priority TEXT NOT NULL,
    thread_id TEXT,
    payload TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    delivered_ms INTEGER
);
CREATE INDEX messages_box ON messages (to_addr, read, seq);
CREATE TABLE gates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    resolution TEXT,
    asker TEXT NOT NULL DEFAULT '',
    created_ms INTEGER NOT NULL
);
CREATE TABLE tab_runs (
    tab TEXT PRIMARY KEY,
    run_id TEXT NOT NULL
);
CREATE TABLE receipts (
    request_id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_ms INTEGER NOT NULL
);
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
";

/// Version 2: directional links between tabs with their read grants (both
/// off by default), and the text settings of Mission Control.
const SCHEMA_V2: &str = "
CREATE TABLE tab_links (
    from_tab TEXT NOT NULL,
    to_tab TEXT NOT NULL,
    transcript INTEGER NOT NULL DEFAULT 0,
    screen INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (from_tab, to_tab)
);
CREATE INDEX tab_links_to ON tab_links (to_tab);
CREATE TABLE meta_text (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX messages_from ON messages (from_addr, seq);
";

pub struct Store {
    pub(crate) conn: Connection,
    counter: Cell<u64>,
    base: u64,
}

/// The text a unit enum is stored as: its serde name.
pub(crate) fn enum_text<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

/// The enum a stored name stands for.
pub fn enum_from<T: DeserializeOwned>(s: &str) -> Result<T, OrchError> {
    serde_json::from_value(serde_json::Value::String(s.to_owned()))
        .map_err(|e| OrchError::new("store", format!("bad stored value {s}: {e}")))
}

/// A stored enum name read back as the enum.
fn parse<T: DeserializeOwned>(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<T> {
    let text: String = row.get(idx)?;
    enum_from(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn parse_opt<T: DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    idx: usize,
) -> rusqlite::Result<Option<T>> {
    match row.get::<_, Option<String>>(idx)? {
        None => Ok(None),
        Some(text) => enum_from(&text).map(Some).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
        }),
    }
}

fn json_col<T: DeserializeOwned>(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<T> {
    let text: String = row.get(idx)?;
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub(crate) const RUN_COLS: &str = "id, objective, coordinator_tab, created_ms";
pub(crate) fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get(0)?,
        objective: r.get(1)?,
        coordinator_tab: r.get(2)?,
        created_ms: r.get(3)?,
    })
}

pub(crate) const TASK_COLS: &str =
    "id, run_id, title, spec, deps, parent, status, result, created_ms, updated_ms";
pub(crate) fn task_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        run_id: r.get(1)?,
        title: r.get(2)?,
        spec: r.get(3)?,
        deps: json_col(r, 4)?,
        parent: r.get(5)?,
        status: parse(r, 6)?,
        result: r.get(7)?,
        created_ms: r.get(8)?,
        updated_ms: r.get(9)?,
    })
}

pub(crate) const DISPATCH_COLS: &str =
    "id, run_id, task_id, status, depth, retry_of, failure_count, parent_dispatch";
pub(crate) fn dispatch_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Dispatch> {
    Ok(Dispatch {
        id: r.get(0)?,
        run_id: r.get(1)?,
        task_id: r.get(2)?,
        status: parse(r, 3)?,
        depth: r.get(4)?,
        retry_of: r.get(5)?,
        failure_count: r.get(6)?,
        parent_dispatch: r.get(7)?,
    })
}

pub(crate) const WORKER_COLS: &str = "dispatch_id, tab, worktree, agent, state, failed_stage, last_error, kept, closes_at_ms, released, created_ms, updated_ms";
pub(crate) fn worker_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Worker> {
    Ok(Worker {
        dispatch_id: r.get(0)?,
        tab: r.get(1)?,
        worktree: r.get(2)?,
        agent: r.get(3)?,
        state: parse(r, 4)?,
        failed_stage: parse_opt(r, 5)?,
        last_error: r.get(6)?,
        kept: r.get::<_, i64>(7)? != 0,
        closes_at_ms: r.get(8)?,
        released: r.get::<_, i64>(9)? != 0,
        created_ms: r.get(10)?,
        updated_ms: r.get(11)?,
    })
}

pub(crate) const MESSAGE_COLS: &str = "id, run_id, from_addr, to_addr, subject, body, kind, priority, thread_id, payload, read, seq, created_ms, delivered_ms";
pub(crate) fn message_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let payload: Option<String> = r.get(9)?;
    Ok(Message {
        id: r.get(0)?,
        run_id: r.get(1)?,
        from: r.get(2)?,
        to: r.get(3)?,
        subject: r.get(4)?,
        body: r.get(5)?,
        kind: parse(r, 6)?,
        priority: parse(r, 7)?,
        thread_id: r.get(8)?,
        payload: payload.and_then(|p| serde_json::from_str(&p).ok()),
        read: r.get::<_, i64>(10)? != 0,
        seq: r.get(11)?,
        created_ms: r.get(12)?,
        delivered_ms: r.get(13)?,
    })
}

pub(crate) const GATE_COLS: &str =
    "id, run_id, task_id, question, options, status, resolution, created_ms";
pub(crate) fn gate_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Gate> {
    Ok(Gate {
        id: r.get(0)?,
        run_id: r.get(1)?,
        task_id: r.get(2)?,
        question: r.get(3)?,
        options: json_col(r, 4)?,
        status: parse(r, 5)?,
        resolution: r.get(6)?,
        created_ms: r.get(7)?,
    })
}

impl Store {
    /// Opens (creating and migrating) the database at `path`, in WAL mode.
    pub fn open(path: &Path) -> Result<Store, OrchError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| OrchError::new("store", format!("cannot create {dir:?}: {e}")))?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let base = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |d| d.as_nanos() as u64);
        let store = Store::init(conn, base)?;
        store.receipts_clear_reserved()?;
        Ok(store)
    }

    /// A database that lives and dies with the value; ids start from a fixed seed.
    pub fn open_in_memory() -> Result<Store, OrchError> {
        Store::init(Connection::open_in_memory()?, 1)
    }

    fn init(conn: Connection, base: u64) -> Result<Store, OrchError> {
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Store {
            conn,
            counter: Cell::new(0),
            base,
        };
        store.migrate()?;
        Ok(store)
    }

    /// The `user_version` of the open database.
    pub fn version(&self) -> Result<i32, OrchError> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))?)
    }

    fn migrate(&self) -> Result<(), OrchError> {
        let version = self.version()?;
        if version > SCHEMA_VERSION {
            return Err(OrchError::new(
                "store",
                format!("orchestration.db is from a newer xDev (schema {version})"),
            ));
        }
        if version < 1 {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(SCHEMA_V1)?;
            tx.pragma_update(None, "user_version", 1)?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(SCHEMA_V2)?;
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// The journal mode, for tests and diagnostics.
    pub fn journal_mode(&self) -> Result<String, OrchError> {
        Ok(self
            .conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))?)
    }

    /// Runs `f` as one unit: every write it makes lands, or none does. Built
    /// on a savepoint, so units nest.
    pub fn atomic<T>(
        &self,
        f: impl FnOnce(&Store) -> Result<T, OrchError>,
    ) -> Result<T, OrchError> {
        self.conn.execute_batch("SAVEPOINT orch_unit")?;
        match f(self) {
            Ok(v) => {
                self.conn.execute_batch("RELEASE orch_unit")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self
                    .conn
                    .execute_batch("ROLLBACK TO orch_unit; RELEASE orch_unit");
                Err(e)
            }
        }
    }

    /// A number kept under `key` (for state the app must keep across runs).
    pub fn meta_get(&self, key: &str) -> Result<Option<i64>, OrchError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    /// Keeps `value` under `key`; none forgets it.
    pub fn meta_set(&self, key: &str, value: Option<i64>) -> Result<(), OrchError> {
        match value {
            Some(v) => self.conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, v],
            )?,
            None => self
                .conn
                .execute("DELETE FROM meta WHERE key = ?1", [key])?,
        };
        Ok(())
    }

    /// A fresh id: `<prefix>_<12 hex>`; never the same twice from one store.
    pub fn next_id(&self, prefix: &str) -> String {
        let n = self.counter.get() + 1;
        self.counter.set(n);
        new_id(prefix, self.base.wrapping_add(n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_database_is_at_the_current_schema() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.version().unwrap(), SCHEMA_VERSION);
        let tables: Vec<String> = s
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            tables,
            [
                "dispatches",
                "gates",
                "messages",
                "meta",
                "meta_text",
                "receipts",
                "runs",
                "tab_links",
                "tab_runs",
                "tasks",
                "workers"
            ]
        );
    }

    #[test]
    fn meta_keeps_a_number_until_it_is_forgotten() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.meta_get("k").unwrap(), None);
        s.meta_set("k", Some(5)).unwrap();
        s.meta_set("k", Some(7)).unwrap();
        assert_eq!(s.meta_get("k").unwrap(), Some(7));
        s.meta_set("k", None).unwrap();
        assert_eq!(s.meta_get("k").unwrap(), None);
    }

    #[test]
    fn a_file_database_uses_wal_and_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("orchestration.db");
        {
            let s = Store::open(&path).unwrap();
            assert_eq!(s.journal_mode().unwrap(), "wal");
            s.conn
                .execute(
                    "INSERT INTO runs (id, objective, created_ms) VALUES ('run_a', 'x', 1)",
                    [],
                )
                .unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.version().unwrap(), SCHEMA_VERSION);
        let n: i64 = s
            .conn
            .query_row("SELECT COUNT(*) FROM runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_version_1_database_is_moved_to_version_2_and_keeps_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v1.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO runs (id, objective, created_ms) VALUES ('run_a', 'x', 1)",
                [],
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.version().unwrap(), 2);
        assert_eq!(s.run_list().unwrap().len(), 1);
        assert!(s.link_list().unwrap().is_empty());
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.db");
        Store::open(&path)
            .unwrap()
            .conn
            .pragma_update(None, "user_version", 99)
            .unwrap();
        let err = Store::open(&path).err().unwrap();
        assert_eq!(err.code, "store");
    }

    #[test]
    fn ids_from_one_store_never_repeat() {
        let s = Store::open_in_memory().unwrap();
        let a = s.next_id("task");
        let b = s.next_id("task");
        assert_ne!(a, b);
        assert!(a.starts_with("task_"));
    }

    #[test]
    fn enums_are_stored_by_their_serde_name() {
        use crate::model::WorkerState;
        assert_eq!(enum_text(&WorkerState::StartUnknown), "start_unknown");
        assert_eq!(
            enum_from::<WorkerState>("stop_unknown").unwrap(),
            WorkerState::StopUnknown
        );
        assert!(enum_from::<WorkerState>("bogus").is_err());
    }
}
