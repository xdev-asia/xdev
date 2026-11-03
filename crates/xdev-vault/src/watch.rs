use std::collections::BTreeSet;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};

use crate::{VaultError, path};

/// Editors often save in several steps (truncate, write, rename); 300 ms
/// folds those into one report.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Watching stops when this is dropped.
///
/// `NoCache`, not the default file-id cache: on Windows and macOS that cache
/// walks the whole tree when watching starts, which took 36 s on a 455k-file
/// repo and held the vault open (and the window blank) until it finished.
/// Only the file-id rename stitching is lost, and changes are reported by
/// path anyway.
pub struct VaultWatcher {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

pub(crate) fn start(
    root: PathBuf,
    on_change: impl Fn(Vec<String>) + Send + 'static,
) -> Result<VaultWatcher, VaultError> {
    let watch_root = root.clone();
    let handler = move |res: DebounceEventResult| {
        // Errors are dropped: the caller re-syncs from disk on the next
        // change, which recovers anything a failed event would have carried.
        let Ok(events) = res else { return };
        let changed: BTreeSet<String> = events
            .iter()
            .flat_map(|e| e.paths.iter())
            .filter(|p| path::is_md(p))
            .filter_map(|p| path::to_rel(&root, p))
            .filter(|rel| !path::in_builtin_dir(rel))
            .collect();
        if !changed.is_empty() {
            on_change(changed.into_iter().collect());
        }
    };
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        DEBOUNCE,
        None,
        handler,
        NoCache::new(),
        notify::Config::default(),
    )
    .map_err(io::Error::other)?;
    debouncer
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(io::Error::other)?;
    Ok(VaultWatcher {
        _debouncer: debouncer,
    })
}
