//! Live file watching: one watcher per worktree root, shared by every
//! subscriber. Events are made worktree-relative, filtered, coalesced and
//! flushed in batches (75 ms leading, 100 ms cadence).
// The watcher itself arrives in the next commit and puts these to use.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;
use tauri::ipc::Channel;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::known_checkout;

/// One watched path, relative to the worktree, `/`-separated.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub kind: FsEventKind,
    /// "" for `Overflow` (the whole worktree).
    pub rel: String,
    /// From a stat after the event; None for deletes and overflow.
    pub dir: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FsEventKind {
    Create,
    Update,
    Delete,
    Overflow,
}

/// One flushed batch for one worktree.
#[derive(Clone, Debug, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FsChanged {
    pub worktree: String,
    pub events: Vec<FsEvent>,
}

pub const IGNORED_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "target",
    ".venv",
    "__pycache__",
];
/// The first event of a batch flushes after this long.
pub const LEADING: Duration = Duration::from_millis(75);
/// Flushes come at least this far apart.
pub const INTERVAL: Duration = Duration::from_millis(100);
/// A batch with more events than this becomes one `Overflow`.
pub const MAX_EVENTS: usize = 5000;

impl FsEvent {
    fn overflow() -> FsEvent {
        FsEvent {
            kind: FsEventKind::Overflow,
            rel: String::new(),
            dir: None,
        }
    }
}

/// True when any component of `rel` is in `IGNORED_DIRS`.
pub(crate) fn ignored(rel: &str) -> bool {
    rel.split(['/', '\\'])
        .any(|part| IGNORED_DIRS.contains(&part))
}

/// Per-path coalescing, in order of first appearance:
/// create then delete cancels out; delete then create keeps both; otherwise
/// the last kind wins (an update after a create stays a create). An `Overflow` swallows the whole batch.
pub(crate) fn coalesce(events: Vec<FsEvent>) -> Vec<FsEvent> {
    if events.iter().any(|e| e.kind == FsEventKind::Overflow) {
        return vec![FsEvent::overflow()];
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_path: HashMap<String, Vec<FsEvent>> = HashMap::new();
    for e in events {
        let list = by_path.entry(e.rel.clone()).or_insert_with(|| {
            order.push(e.rel.clone());
            Vec::new()
        });
        let Some(last) = list.last().map(|l| l.kind) else {
            list.push(e);
            continue;
        };
        match (last, e.kind) {
            (FsEventKind::Create, FsEventKind::Delete) => {
                list.pop();
            }
            // The file is back after a delete: that is a create.
            (FsEventKind::Delete, FsEventKind::Create | FsEventKind::Update) => {
                list.push(FsEvent {
                    kind: FsEventKind::Create,
                    ..e
                });
            }
            (FsEventKind::Delete, FsEventKind::Delete) => {}
            // The file is still the one this batch created.
            (FsEventKind::Create, FsEventKind::Update) => {}
            _ => {
                list.pop();
                list.push(e);
            }
        }
    }
    order
        .into_iter()
        .flat_map(|rel| by_path.remove(&rel).unwrap_or_default())
        .collect()
}

/// The flush clock: no threads and no sleeping, it only takes `now`.
#[derive(Debug, Default)]
pub(crate) struct Batch {
    pending: Vec<FsEvent>,
    last_flush: Option<Instant>,
    armed: Option<Instant>,
}

impl Batch {
    /// Adds `e`. Returns the flush deadline when this push armed it; an
    /// armed timer is not reset by later pushes.
    pub(crate) fn push(&mut self, e: FsEvent, now: Instant) -> Option<Instant> {
        self.pending.push(e);
        if self.armed.is_some() {
            return None;
        }
        let mut deadline = now + LEADING;
        if let Some(last) = self.last_flush {
            deadline = deadline.max(last + INTERVAL);
        }
        self.armed = Some(deadline);
        Some(deadline)
    }

    /// When the next flush is due, if anything is waiting.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.armed
    }

    /// Takes the batch: coalesced, or one `Overflow` when it is too big.
    pub(crate) fn flush(&mut self, now: Instant) -> Vec<FsEvent> {
        self.armed = None;
        self.last_flush = Some(now);
        let events = coalesce(std::mem::take(&mut self.pending));
        if events.len() > MAX_EVENTS {
            vec![FsEvent::overflow()]
        } else {
            events
        }
    }
}

#[derive(Default)]
struct Inner {}

/// Managed state: root -> (watcher, subscribers); id -> root.
#[derive(Default, Clone)]
pub struct FileWatches(Arc<Mutex<Inner>>);

/// Starts sending `FsChanged` batches of `worktree` to `on_event` under `id`.
#[tauri::command]
pub fn files_watch(
    state: State<'_, AppState>,
    _watches: State<'_, FileWatches>,
    worktree: std::path::PathBuf,
    _id: String,
    _on_event: Channel<FsChanged>,
) -> Result<(), CmdError> {
    known_checkout(data_dir(&state)?, &worktree)?;
    Ok(())
}

/// Stops the subscription `id`; nothing when it is not there.
#[tauri::command]
pub fn files_unwatch(_watches: State<'_, FileWatches>, _id: String) -> Result<(), CmdError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: FsEventKind, rel: &str) -> FsEvent {
        FsEvent {
            kind,
            rel: rel.to_owned(),
            dir: None,
        }
    }

    fn kinds(events: &[FsEvent]) -> Vec<(FsEventKind, &str)> {
        events.iter().map(|e| (e.kind, e.rel.as_str())).collect()
    }

    use FsEventKind::{Create, Delete, Overflow, Update};

    #[test]
    fn ignored_matches_each_dir_at_any_depth() {
        for dir in IGNORED_DIRS {
            assert!(ignored(dir), "{dir}");
            assert!(ignored(&format!("{dir}/x.js")), "{dir}/x.js");
            assert!(ignored(&format!("a/b/c/{dir}/x.js")), "deep {dir}");
            assert!(ignored(&format!("a/b/{dir}")), "deep {dir} itself");
        }
        assert!(ignored("a\\node_modules\\x"));
    }

    #[test]
    fn ignored_leaves_lookalikes_alone() {
        for rel in [
            "src/build.rs",
            "src/target.txt",
            "dist-info/x",
            "gitignore",
            "a/b.git",
        ] {
            assert!(!ignored(rel), "{rel}");
        }
    }

    #[test]
    fn coalesce_create_then_delete_cancels_out() {
        let out = coalesce(vec![ev(Create, "a"), ev(Update, "a"), ev(Delete, "a")]);
        assert!(out.is_empty());
    }

    #[test]
    fn coalesce_delete_then_create_keeps_both() {
        let out = coalesce(vec![ev(Delete, "a"), ev(Create, "a")]);
        assert_eq!(kinds(&out), [(Delete, "a"), (Create, "a")]);
        let out = coalesce(vec![ev(Delete, "a"), ev(Create, "a"), ev(Update, "a")]);
        assert_eq!(kinds(&out), [(Delete, "a"), (Create, "a")]);
    }

    #[test]
    fn coalesce_otherwise_the_last_kind_wins_in_first_seen_order() {
        let out = coalesce(vec![
            ev(Update, "b"),
            ev(Create, "a"),
            ev(Update, "b"),
            ev(Update, "a"),
            ev(Update, "c"),
            ev(Delete, "c"),
        ]);
        assert_eq!(kinds(&out), [(Update, "b"), (Create, "a"), (Delete, "c")]);
    }

    #[test]
    fn coalesce_overflow_swallows_the_batch() {
        let out = coalesce(vec![ev(Update, "a"), ev(Overflow, ""), ev(Delete, "b")]);
        assert_eq!(kinds(&out), [(Overflow, "")]);
    }

    #[test]
    fn batch_flushes_the_first_event_after_the_leading_delay() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        assert_eq!(b.due(), None);
        assert_eq!(b.push(ev(Update, "a"), t0), Some(t0 + LEADING));
        assert_eq!(b.due(), Some(t0 + LEADING));
    }

    #[test]
    fn batch_does_not_reset_an_armed_timer() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        b.push(ev(Update, "a"), t0);
        assert_eq!(
            b.push(ev(Update, "b"), t0 + Duration::from_millis(60)),
            None
        );
        assert_eq!(b.due(), Some(t0 + LEADING));
        let out = b.flush(t0 + LEADING);
        assert_eq!(kinds(&out), [(Update, "a"), (Update, "b")]);
        assert_eq!(b.due(), None);
    }

    #[test]
    fn batch_keeps_flushes_an_interval_apart() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        b.push(ev(Update, "a"), t0);
        b.flush(t0 + LEADING);
        // 10 ms after a flush: the interval (100 ms) is the later bound.
        let now = t0 + LEADING + Duration::from_millis(10);
        assert_eq!(b.push(ev(Update, "b"), now), Some(t0 + LEADING + INTERVAL));
        // Long after a flush: the leading delay applies again.
        b.flush(t0 + LEADING + INTERVAL);
        let late = t0 + Duration::from_secs(5);
        assert_eq!(b.push(ev(Update, "c"), late), Some(late + LEADING));
    }

    #[test]
    fn batch_turns_more_than_the_maximum_into_one_overflow() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        for i in 0..=MAX_EVENTS {
            b.push(ev(Update, &format!("f{i}")), t0);
        }
        let out = b.flush(t0 + LEADING);
        assert_eq!(kinds(&out), [(Overflow, "")]);
    }

    #[test]
    fn batch_keeps_a_batch_of_exactly_the_maximum() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        for i in 0..MAX_EVENTS {
            b.push(ev(Update, &format!("f{i}")), t0);
        }
        assert_eq!(b.flush(t0 + LEADING).len(), MAX_EVENTS);
    }
}
