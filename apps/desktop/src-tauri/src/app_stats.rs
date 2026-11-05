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
    pub(crate) fn load(_path: &Path) -> Stats {
        Stats::default()
    }

    pub(crate) fn save(&self, _path: &Path) -> std::io::Result<()> {
        Ok(())
    }

    pub(crate) fn view(&self, _mono_now: u64) -> AppStatsView {
        AppStatsView {
            agents_started: 0,
            prs_created: 0,
            agent_busy_ms: 0,
            since_ms: None,
        }
    }

    pub(crate) fn agent_started(&mut self, _wall_now: i64) -> bool {
        false
    }

    pub(crate) fn pr_seen(&mut self, _url: &str, _wall_now: i64) -> bool {
        false
    }

    pub(crate) fn busy(&mut self, _tab: &str, _working: bool, _mono_now: u64, _wall_now: i64) -> bool {
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
