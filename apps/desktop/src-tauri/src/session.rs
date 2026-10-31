use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use xdev_core::{
    CoreError, DocEntry, Repo, SearchHit, Store, Vault, VaultError, VaultWatcher, Written,
    content_hash, index_path, read_version, search, sync_vault,
};

use crate::commands::CmdError;

type Slot = Mutex<Option<Session>>;

pub struct Session {
    vault: Vault,
    store: Store,
    /// Tells this session's watcher apart from the one of a vault opened
    /// earlier: a dropped debouncer's thread can still fire once.
    generation: u64,
    /// Found lazily and looked up again while missing, so a `git init` in a
    /// terminal is picked up without reopening the vault.
    repo: Option<Repo>,
    written: Written,
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
        self.written
            .insert(path.to_owned(), content_hash(content.as_bytes()));
        sync_vault(&self.vault, &mut self.store)?;
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, CoreError> {
        search(&self.store, query, limit)
    }
}

/// What git work needs, copied out of the session so git runs outside the
/// lock: a slow hook or a large status must not stall typing and search.
pub struct Review {
    pub vault: Vault,
    pub repo: Repo,
    pub written: Written,
    generation: u64,
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
            repo: None,
            written: Written::new(),
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

    /// Fails with `no_repo` / `no_git` until there is a repo to work with.
    pub fn review(&self) -> Result<Review, CmdError> {
        let (root, repo, written, generation) = {
            let current = self.lock();
            let s = current.as_ref().ok_or_else(CmdError::no_vault)?;
            (
                s.vault.root().to_path_buf(),
                s.repo.clone(),
                s.written.clone(),
                s.generation,
            )
        };
        let repo = match repo {
            Some(repo) => repo,
            None => {
                let repo = Repo::discover(&root).map_err(CoreError::from)?;
                self.set_repo(generation, &repo);
                repo
            }
        };
        Ok(Review {
            vault: Vault::open(&root).map_err(CoreError::from)?,
            repo,
            written,
            generation,
        })
    }

    pub fn vcs_state(&self) -> Result<&'static str, CmdError> {
        match self.review() {
            Ok(_) => Ok("ok"),
            Err(e) if e.code == "no_repo" || e.code == "no_git" => Ok(e.code),
            Err(e) => Err(e),
        }
    }

    /// A vault already inside a repo is left alone: a nested repo would hide
    /// its docs from the outer one.
    pub fn init_repo(&self) -> Result<(), CmdError> {
        match self.review() {
            Ok(_) => return Ok(()),
            Err(e) if e.code == "no_repo" => {}
            Err(e) => return Err(e),
        }
        let (root, generation) = self.root()?;
        let repo = Repo::init(&root).map_err(CoreError::from)?;
        self.set_repo(generation, &repo);
        Ok(())
    }

    /// Approved or rejected docs no longer hold xDev's last write. A path
    /// written again since the snapshot keeps its new entry.
    pub fn forget(&self, review: &Review, paths: &[String]) {
        let mut current = self.lock();
        let Some(s) = current
            .as_mut()
            .filter(|s| s.generation == review.generation)
        else {
            return;
        };
        for path in paths {
            if s.written.get(path) == review.written.get(path) {
                s.written.remove(path);
            }
        }
    }

    /// Goes through `Session::write`, so the restored text is reviewed like
    /// any other edit from the app.
    pub fn restore_version(&self, path: &str, id: &str) -> Result<(), CmdError> {
        let review = self.review()?;
        let content = read_version(&review.repo, path, id)?
            .ok_or_else(|| CoreError::from(VaultError::NotFound(path.to_owned())))?;
        self.with(|s| s.write(path, &content))
    }

    fn root(&self) -> Result<(PathBuf, u64), CmdError> {
        let current = self.lock();
        let s = current.as_ref().ok_or_else(CmdError::no_vault)?;
        Ok((s.vault.root().to_path_buf(), s.generation))
    }

    fn set_repo(&self, generation: u64, repo: &Repo) {
        let mut current = self.lock();
        if let Some(s) = current.as_mut().filter(|s| s.generation == generation) {
            s.repo = Some(repo.clone());
        }
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

    /// Runs setup commands; never used for the code under test.
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    }

    /// A vault in its own repo, `a.md` committed, opened in a session.
    fn repo_session() -> (tempfile::TempDir, tempfile::TempDir, Shared) {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(root.path(), &["config", key, value]);
        }
        fs::write(root.path().join("a.md"), "a").unwrap();
        git(root.path(), &["add", "-A"]);
        git(root.path(), &["commit", "-q", "-m", "init"]);
        let shared = Shared::default();
        shared.open(data.path(), root.path(), |_| {}).unwrap();
        (data, root, shared)
    }

    fn changes(shared: &Shared) -> Vec<(String, &'static str)> {
        let r = shared.review().unwrap();
        xdev_core::list_changes(&r.vault, &r.repo, &r.written)
            .unwrap()
            .into_iter()
            .map(|c| {
                let origin = match c.origin {
                    xdev_core::Origin::App => "app",
                    xdev_core::Origin::Outside => "outside",
                };
                (c.path, origin)
            })
            .collect()
    }

    #[test]
    fn vcs_state_no_repo_then_init() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "a").unwrap();
        let shared = Shared::default();
        assert_eq!(shared.vcs_state().unwrap_err(), CmdError::no_vault());
        shared.open(data.path(), root.path(), |_| {}).unwrap();

        assert_eq!(shared.vcs_state().unwrap(), "no_repo");
        assert_eq!(shared.review().err().unwrap().code, "no_repo");
        shared.init_repo().unwrap();
        assert_eq!(shared.vcs_state().unwrap(), "ok");
        assert_eq!(changes(&shared), [("a.md".to_owned(), "outside")]);
        // A second call must not stack a repo inside the first.
        shared.init_repo().unwrap();
    }

    #[test]
    fn write_marks_app_origin_and_outside_edit_marks_outside() {
        let (_data, root, shared) = repo_session();
        assert_eq!(shared.vcs_state().unwrap(), "ok");
        assert!(changes(&shared).is_empty());

        shared.with(|s| s.write("a.md", "a2")).unwrap();
        shared.with(|s| s.write("n.md", "n")).unwrap();
        assert_eq!(
            changes(&shared),
            [("a.md".to_owned(), "app"), ("n.md".to_owned(), "app")]
        );

        fs::write(root.path().join("a.md"), "edited elsewhere").unwrap();
        assert_eq!(
            changes(&shared),
            [("a.md".to_owned(), "outside"), ("n.md".to_owned(), "app")]
        );
    }

    #[test]
    fn approve_clears_written() {
        let (_data, root, shared) = repo_session();
        shared.with(|s| s.write("a.md", "a2")).unwrap();
        let r = shared.review().unwrap();
        let paths = vec!["a.md".to_owned()];
        let id = xdev_core::approve(&r.vault, &r.repo, &r.written, &paths, "")
            .unwrap()
            .expect("a commit");
        shared.forget(&r, &paths);
        assert!(changes(&shared).is_empty());
        assert_eq!(
            git(root.path(), &["log", "-1", "--format=%H %s"]).trim(),
            format!("{id} Update a.md")
        );

        // A terminal commit, then an outside edit back to the approved text:
        // a stale entry would pass it off as the app's.
        fs::write(root.path().join("a.md"), "a3").unwrap();
        git(root.path(), &["commit", "-q", "-am", "three"]);
        fs::write(root.path().join("a.md"), "a2").unwrap();
        assert_eq!(changes(&shared), [("a.md".to_owned(), "outside")]);
    }

    #[test]
    fn forget_keeps_a_write_made_after_the_snapshot() {
        let (_data, _root, shared) = repo_session();
        shared.with(|s| s.write("a.md", "a2")).unwrap();
        let r = shared.review().unwrap();
        shared.with(|s| s.write("a.md", "a3")).unwrap();
        shared.forget(&r, &["a.md".to_owned()]);
        assert_eq!(changes(&shared), [("a.md".to_owned(), "app")]);
    }

    #[test]
    fn restore_version_becomes_pending_app_change() {
        let (_data, root, shared) = repo_session();
        let first = git(root.path(), &["rev-parse", "HEAD"]).trim().to_owned();
        fs::write(root.path().join("a.md"), "a2").unwrap();
        git(root.path(), &["commit", "-q", "-am", "two"]);

        shared.restore_version("a.md", &first).unwrap();
        assert_eq!(shared.with(|s| s.read("a.md")).unwrap(), "a");
        assert_eq!(changes(&shared), [("a.md".to_owned(), "app")]);

        let err = shared.restore_version("gone.md", &first).unwrap_err();
        assert_eq!(err.code, "not_found");
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
