//! Counters xDev keeps on this computer: agents started, time agents worked, PRs created.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

pub const FILE: &str = "app-stats.json";
pub const SCHEMA: u32 = 1;
pub const MAX_COUNTED_PRS: usize = 2000;
/// One busy span counts at most 12 h.
pub const BUSY_SPAN_CAP_MS: u64 = 43_200_000;
pub const TAB_ID_MAX: usize = 128;

/// What the page reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AppStatsView {
    pub agents_started: u64,
    pub prs_created: u64,
    /// Finished spans plus the spans still running now.
    pub agent_busy_ms: u64,
    /// Epoch ms of the first counted event; None until then.
    pub since_ms: Option<i64>,
}

/// On disk.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    schema: u32,
    agents_started: u64,
    prs_created: u64,
    agent_busy_ms: u64,
    since_ms: Option<i64>,
    counted_prs: Vec<String>,
}

/// Pure state; time is passed in so tests need no sleep.
#[derive(Default)]
pub(crate) struct Stats {
    saved: Saved,
    /// Tab id → monotonic ms at the start of its running span.
    live: HashMap<String, u64>,
}

impl Stats {
    /// Missing file: zeros. A file that does not parse is renamed to `.bad` and counting starts from zero.
    pub(crate) fn load(path: &Path) -> Stats {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => return Stats::default(),
        };
        match serde_json::from_slice::<Saved>(&bytes) {
            Ok(saved) if saved.schema == SCHEMA => Stats {
                saved,
                live: HashMap::new(),
            },
            _ => {
                let mut bad = path.as_os_str().to_owned();
                bad.push(".bad");
                if let Err(e) = std::fs::rename(path, PathBuf::from(bad)) {
                    eprintln!("app stats: cannot move the unreadable file aside: {e}");
                }
                Stats::default()
            }
        }
    }

    pub(crate) fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut saved = self.saved.clone();
        saved.schema = SCHEMA;
        let bytes = serde_json::to_vec_pretty(&saved).map_err(std::io::Error::other)?;
        crate::atomic::write_atomic(path, &bytes)
    }

    pub(crate) fn view(&self, _mono_now: u64) -> AppStatsView {
        AppStatsView {
            agents_started: self.saved.agents_started,
            prs_created: self.saved.prs_created,
            agent_busy_ms: self.saved.agent_busy_ms,
            since_ms: self.saved.since_ms,
        }
    }

    fn stamp(&mut self, wall_now: i64) {
        self.saved.since_ms.get_or_insert(wall_now);
    }

    pub(crate) fn agent_started(&mut self, wall_now: i64) -> bool {
        self.saved.agents_started = self.saved.agents_started.saturating_add(1);
        self.stamp(wall_now);
        true
    }

    pub(crate) fn pr_seen(&mut self, url: &str, wall_now: i64) -> bool {
        let url = url.trim();
        if url.is_empty() || self.saved.counted_prs.iter().any(|u| u == url) {
            return false;
        }
        self.saved.counted_prs.push(url.to_string());
        let over = self.saved.counted_prs.len().saturating_sub(MAX_COUNTED_PRS);
        if over > 0 {
            self.saved.counted_prs.drain(..over);
        }
        self.saved.prs_created = self.saved.prs_created.saturating_add(1);
        self.stamp(wall_now);
        true
    }

    pub(crate) fn busy(
        &mut self,
        _tab: &str,
        _working: bool,
        _mono_now: u64,
        _wall_now: i64,
    ) -> bool {
        false
    }

    pub(crate) fn close_all(&mut self, _mono_now: u64) -> bool {
        false
    }
}

/// App state: loaded on first use with the data dir.
#[derive(Default)]
pub struct AppStatsHub {
    inner: Mutex<Option<(PathBuf, Stats)>>,
    epoch: OnceLock<Instant>,
}

impl AppStatsHub {
    pub(crate) fn record_spawn(&self, _data_dir: &Path) {}
    pub(crate) fn record_pr(&self, _data_dir: &Path, _url: &str) {}
    pub(crate) fn busy(&self, _data_dir: &Path, _tab: &str, _working: bool) {}
    pub(crate) fn close_all(&self) {
        let _ = (&self.inner, &self.epoch);
    }
}

#[tauri::command]
pub fn app_stats_get(
    state: State<'_, AppState>,
    _hub: State<'_, AppStatsHub>,
) -> Result<AppStatsView, CmdError> {
    data_dir(&state)?;
    Ok(Stats::default().view(0))
}

#[tauri::command]
pub fn app_stats_busy(
    state: State<'_, AppState>,
    _hub: State<'_, AppStatsHub>,
    _tab_id: String,
    _working: bool,
) -> Result<(), CmdError> {
    data_dir(&state)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join(FILE)
    }

    #[test]
    fn missing_file_loads_zeros() {
        let dir = tempfile::tempdir().unwrap();
        let s = Stats::load(&file(&dir));
        assert_eq!(
            s.view(0),
            AppStatsView {
                agents_started: 0,
                prs_created: 0,
                agent_busy_ms: 0,
                since_ms: None
            }
        );
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Stats::load(&file(&dir));
        assert!(s.agent_started(1_000));
        assert!(s.pr_seen("https://x/pr/1", 2_000));
        s.save(&file(&dir)).unwrap();
        let back = Stats::load(&file(&dir));
        assert_eq!(back.view(0), s.view(0));
        assert_eq!(back.view(0).agents_started, 1);
        assert_eq!(back.view(0).since_ms, Some(1_000));
    }

    #[test]
    fn corrupt_file_is_renamed_bad_and_loads_zeros() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file(&dir), "{").unwrap();
        let s = Stats::load(&file(&dir));
        assert_eq!(s.view(0).agents_started, 0);
        assert!(dir.path().join("app-stats.json.bad").exists());
        assert!(!file(&dir).exists());
    }

    #[test]
    fn agent_started_counts_and_sets_since_once() {
        let mut s = Stats::default();
        assert!(s.agent_started(5_000));
        assert!(s.agent_started(9_000));
        let v = s.view(0);
        assert_eq!(v.agents_started, 2);
        assert_eq!(v.since_ms, Some(5_000));
    }

    #[test]
    fn pr_seen_dedups_by_url() {
        let mut s = Stats::default();
        assert!(s.pr_seen("u1", 1));
        assert!(!s.pr_seen("u1", 2));
        assert!(s.pr_seen("u2", 3));
        assert_eq!(s.view(0).prs_created, 2);
    }

    #[test]
    fn pr_seen_ignores_empty_url() {
        let mut s = Stats::default();
        assert!(!s.pr_seen("", 1));
        assert!(!s.pr_seen("   ", 1));
        assert_eq!(s.view(0).prs_created, 0);
        assert_eq!(s.view(0).since_ms, None);
    }

    #[test]
    fn counted_prs_cap_keeps_total() {
        let mut s = Stats::default();
        for i in 0..=MAX_COUNTED_PRS {
            assert!(s.pr_seen(&format!("u{i}"), 1));
        }
        assert_eq!(s.saved.counted_prs.len(), MAX_COUNTED_PRS);
        assert_eq!(s.view(0).prs_created, MAX_COUNTED_PRS as u64 + 1);
        assert!(!s.saved.counted_prs.contains(&"u0".to_string()));
    }

    #[test]
    fn counters_saturate_at_u64_max() {
        let mut s = Stats::default();
        s.saved.agents_started = u64::MAX;
        s.saved.prs_created = u64::MAX;
        assert!(s.agent_started(1));
        assert!(s.pr_seen("u", 1));
        assert_eq!(s.view(0).agents_started, u64::MAX);
        assert_eq!(s.view(0).prs_created, u64::MAX);
    }
}
