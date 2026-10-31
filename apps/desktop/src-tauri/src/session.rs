use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use xdev_core::{
    CoreError, DocEntry, SearchHit, Store, Vault, VaultWatcher, index_path, search, sync_vault,
};

use crate::commands::CmdError;

type Slot = Mutex<Option<Session>>;

pub struct Session {
    vault: Vault,
    store: Store,
    /// Tells this session's watcher apart from the one of a vault opened
    /// earlier: a dropped debouncer's thread can still fire once.
    generation: u64,
    _watcher: VaultWatcher,
}

impl Session {
    /// A full sync rather than a plain listing, so the list the UI shows and
    /// the index it searches never disagree.
    pub fn list(&mut self) -> Result<Vec<DocEntry>, CoreError> {
        sync_vault(&self.vault, &mut self.store)
    }

    pub fn read(&self, path: &str) -> Result<String, CoreError> {
        Ok(self.vault.read(path)?)
    }

    /// Re-indexes right away so a search just after saving finds the new
    /// text without waiting for the watcher.
    pub fn write(&mut self, path: &str, content: &str) -> Result<(), CoreError> {
        self.vault.write(path, content)?;
        sync_vault(&self.vault, &mut self.store)?;
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, CoreError> {
        search(&self.store, query, limit)
    }
}

/// `Store` is a single SQLite connection and not `Sync`, so commands and the
/// watcher take turns through one lock.
#[derive(Clone, Default)]
pub struct Shared(Arc<Slot>);

impl Shared {
    /// Replaces the open vault only once the new one has synced, so a failed
    /// open leaves the previous vault usable.
    pub fn open(
        &self,
        data_dir: &Path,
        path: &Path,
        on_changed: impl Fn(Vec<String>) + Send + 'static,
    ) -> Result<Vec<DocEntry>, CoreError> {
        static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);

        let vault = Vault::open(path)?;
        let store = Store::open(&index_path(data_dir, &vault))?;
        // Weak: the session owns the watcher, so a strong handle would keep
        // the session alive through its own callback.
        let slot = Arc::downgrade(&self.0);
        // Started before the first sync so no edit slips in between; its
        // callback blocks on the lock until the session is in place.
        let watcher = vault.watch(move |paths| on_change(&slot, generation, paths, &on_changed))?;
        let mut session = Session {
            vault,
            store,
            generation,
            _watcher: watcher,
        };

        let mut current = self.lock();
        let entries = sync_vault(&session.vault, &mut session.store)?;
        let previous = current.replace(session);
        drop(current);
        drop(previous);
        Ok(entries)
    }

    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Session) -> Result<T, CoreError>,
    ) -> Result<T, CmdError> {
        let mut current = self.lock();
        let session = current.as_mut().ok_or_else(CmdError::no_vault)?;
        Ok(f(session)?)
    }

    fn lock(&self) -> MutexGuard<'_, Option<Session>> {
        lock(&self.0)
    }
}

/// A panic in one command must not lock the user out for the rest of the
/// run; the index is a cache that the next sync repairs.
fn lock(slot: &Slot) -> MutexGuard<'_, Option<Session>> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs on the debouncer thread.
fn on_change(
    slot: &Weak<Slot>,
    generation: u64,
    paths: Vec<String>,
    notify: &impl Fn(Vec<String>),
) {
    let Some(slot) = slot.upgrade() else { return };
    {
        let mut current = lock(&slot);
        let Some(session) = current.as_mut().filter(|s| s.generation == generation) else {
            return;
        };
        // The watcher reports raw paths, gitignored ones included; a sync
        // applies the vault's own rules. Its error is dropped because the
        // files did change, and the UI must still check open docs for
        // conflicts.
        let _ = sync_vault(&session.vault, &mut session.store);
    }
    // Outside the lock so a slow listener cannot stall commands.
    notify(paths);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    fn paths(entries: &[DocEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.path.as_str()).collect()
    }

    fn hit_paths(shared: &Shared, query: &str) -> Vec<String> {
        shared
            .with(|s| s.search(query, 10))
            .unwrap()
            .into_iter()
            .map(|h| h.path)
            .collect()
    }

    #[test]
    fn no_vault_before_open() {
        let shared = Shared::default();
        let err = shared.with(|s| s.list()).unwrap_err();
        assert_eq!(err, CmdError::no_vault());
    }

    #[test]
    fn open_list_write_search_and_watch() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "# Alpha\n\nTài liệu hướng dẫn").unwrap();

        let shared = Shared::default();
        let (tx, rx) = mpsc::channel();
        let entries = shared
            .open(data.path(), root.path(), move |p| {
                let _ = tx.send(p);
            })
            .unwrap();
        assert_eq!(paths(&entries), ["a.md"]);
        assert_eq!(hit_paths(&shared, "tai lieu"), ["a.md"]);

        shared
            .with(|s| s.write("b.md", "# Beta\n\nbanana"))
            .unwrap();
        assert_eq!(shared.with(|s| s.read("b.md")).unwrap(), "# Beta\n\nbanana");
        assert_eq!(hit_paths(&shared, "banana"), ["b.md"]);
        let listed = shared.with(|s| s.list()).unwrap();
        assert_eq!(paths(&listed), ["a.md", "b.md"]);

        // An edit made outside the app reaches the listener only after the
        // index has caught up.
        fs::write(root.path().join("c.md"), "# Gamma\n\ncherry").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let batch = rx.recv_timeout(left).expect("no vault://changed for c.md");
            if batch.iter().any(|p| p == "c.md") {
                break;
            }
        }
        assert_eq!(hit_paths(&shared, "cherry"), ["c.md"]);
    }

    #[test]
    fn failed_open_keeps_previous_vault() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "# Alpha").unwrap();
        let shared = Shared::default();
        shared.open(data.path(), root.path(), |_| {}).unwrap();

        let missing = root.path().join("missing");
        let err = shared.open(data.path(), &missing, |_| {}).unwrap_err();
        assert_eq!(err.code(), "not_found");
        assert_eq!(paths(&shared.with(|s| s.list()).unwrap()), ["a.md"]);
    }

    #[test]
    fn stale_watcher_is_ignored() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let shared = Shared::default();
        shared.open(data.path(), root.path(), |_| {}).unwrap();
        let current = shared.lock().as_ref().unwrap().generation;
        let slot = Arc::downgrade(&shared.0);
        let fired = AtomicBool::new(false);
        let notify = |_| fired.store(true, Ordering::Relaxed);

        on_change(&slot, current + 1, vec!["a.md".into()], &notify);
        assert!(!fired.load(Ordering::Relaxed));
        on_change(&slot, current, vec!["a.md".into()], &notify);
        assert!(fired.load(Ordering::Relaxed));
    }
}
