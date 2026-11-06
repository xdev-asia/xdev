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
/// Most tabs with a running span at once.
const MAX_LIVE: usize = 1000;

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

    pub(crate) fn view(&self, mono_now: u64) -> AppStatsView {
        let running = self.live.values().fold(0u64, |sum, start| {
            sum.saturating_add(span(*start, mono_now))
        });
        AppStatsView {
            agents_started: self.saved.agents_started,
            prs_created: self.saved.prs_created,
            agent_busy_ms: self.saved.agent_busy_ms.saturating_add(running),
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

    /// A tab entered or left the working status. True only when a span closed, so the caller saves.
    pub(crate) fn busy(&mut self, tab: &str, working: bool, mono_now: u64, wall_now: i64) -> bool {
        if working {
            if self.live.contains_key(tab) {
                return false;
            }
            let mut changed = false;
            if self.live.len() >= MAX_LIVE {
                changed = self.close_oldest(mono_now);
            }
            self.live.insert(tab.to_string(), mono_now);
            self.stamp(wall_now);
            return changed;
        }
        match self.live.remove(tab) {
            Some(start) => {
                self.add_span(start, mono_now);
                true
            }
            None => false,
        }
    }

    pub(crate) fn close_all(&mut self, mono_now: u64) -> bool {
        let spans: Vec<u64> = self.live.drain().map(|(_, start)| start).collect();
        for start in &spans {
            self.add_span(*start, mono_now);
        }
        !spans.is_empty()
    }

    fn close_oldest(&mut self, mono_now: u64) -> bool {
        let oldest = self
            .live
            .iter()
            .min_by_key(|(_, start)| **start)
            .map(|(k, _)| k.clone());
        match oldest.and_then(|k| self.live.remove(&k)) {
            Some(start) => {
                self.add_span(start, mono_now);
                true
            }
            None => false,
        }
    }

    fn add_span(&mut self, start: u64, mono_now: u64) {
        self.saved.agent_busy_ms = self
            .saved
            .agent_busy_ms
            .saturating_add(span(start, mono_now));
    }
}

/// Elapsed ms of one span, at most `BUSY_SPAN_CAP_MS`.
fn span(start: u64, mono_now: u64) -> u64 {
    mono_now.saturating_sub(start).min(BUSY_SPAN_CAP_MS)
}

/// App state: loaded on first use with the data dir.
#[derive(Default)]
pub struct AppStatsHub {
    inner: Mutex<Option<(PathBuf, Stats)>>,
    epoch: OnceLock<Instant>,
}

impl AppStatsHub {
    fn mono_now(&self) -> u64 {
        self.epoch.get_or_init(Instant::now).elapsed().as_millis() as u64
    }

    /// Runs `f` on the stats loaded from `data_dir` (read on first use). Saves when `f` returns true;
    /// a failed save is logged and never returned.
    pub(crate) fn with(&self, data_dir: &Path, f: impl FnOnce(&mut Stats, u64, i64) -> bool) {
        let mono = self.mono_now();
        let wall = wall_now_ms();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_none_or(|(dir, _)| dir != data_dir) {
            let path = data_dir.join(FILE);
            *guard = Some((data_dir.to_path_buf(), Stats::load(&path)));
        }
        let Some((dir, stats)) = guard.as_mut() else {
            return;
        };
        if f(stats, mono, wall)
            && let Err(e) = stats.save(&dir.join(FILE))
        {
            eprintln!("app stats: cannot save: {e}");
        }
    }

    pub(crate) fn record_spawn(&self, data_dir: &Path) {
        self.with(data_dir, |s, _, wall| s.agent_started(wall));
    }

    pub(crate) fn record_pr(&self, data_dir: &Path, url: &str) {
        self.with(data_dir, |s, _, wall| s.pr_seen(url, wall));
    }

    pub(crate) fn busy(&self, data_dir: &Path, tab: &str, working: bool) {
        self.with(data_dir, |s, mono, wall| s.busy(tab, working, mono, wall));
    }

    /// Closes every running span, at quit. Does nothing when nothing was ever loaded.
    pub(crate) fn close_all(&self) {
        let mono = self.mono_now();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some((dir, stats)) = guard.as_mut() else {
            return;
        };
        if stats.close_all(mono)
            && let Err(e) = stats.save(&dir.join(FILE))
        {
            eprintln!("app stats: cannot save: {e}");
        }
    }
}

fn wall_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Whether a `pty_spawn` with these inputs is a fresh agent start: an agent that is not a plain
/// resume. A fork of a session is a new agent.
pub(crate) fn counts_as_start(agent: bool, resume: Option<&str>, fork: Option<bool>) -> bool {
    agent && (resume.is_none() || fork == Some(true))
}

/// A tab id the busy command accepts: not empty, at most `TAB_ID_MAX` bytes.
pub(crate) fn valid_tab_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= TAB_ID_MAX
}

#[tauri::command]
pub fn app_stats_get(
    state: State<'_, AppState>,
    hub: State<'_, AppStatsHub>,
) -> Result<AppStatsView, CmdError> {
    let dir = data_dir(&state)?;
    let mut out = None;
    hub.with(dir, |s, mono, _| {
        out = Some(s.view(mono));
        false
    });
    out.ok_or(CmdError {
        code: "io",
        detail: Some("stats unavailable".into()),
    })
}

#[tauri::command]
pub fn app_stats_busy(
    state: State<'_, AppState>,
    hub: State<'_, AppStatsHub>,
    tab_id: String,
    working: bool,
) -> Result<(), CmdError> {
    if !valid_tab_id(&tab_id) {
        return Err(CmdError {
            code: "bad_arg",
            detail: Some("tab id".into()),
        });
    }
    hub.busy(data_dir(&state)?, &tab_id, working);
    Ok(())
}

/// The usage archive: one line per finished day, `{v:1, day, input, output, cacheRead, cacheWrite}`,
/// in `<local data>/usage-archive.jsonl`. It is written on every plan, so the history exists when
/// someone upgrades; only reading past what the agent CLIs keep needs `pro.usage_history`.
pub const ARCHIVE_FILE: &str = "usage-archive.jsonl";
pub const ARCHIVE_VERSION: u32 = 1;
/// The gated feature.
pub const HISTORY_FEATURE: &str = "pro.usage_history";

/// Token totals of one local day.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DayTotals {
    /// Local `YYYY-MM-DD`.
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl DayTotals {
    fn sum(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }
}

/// A line on disk.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveLine {
    v: u32,
    day: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

impl ArchiveLine {
    fn of(d: &DayTotals) -> ArchiveLine {
        ArchiveLine {
            v: ARCHIVE_VERSION,
            day: d.day.clone(),
            input: d.input,
            output: d.output,
            cache_read: d.cache_read,
            cache_write: d.cache_write,
        }
    }
}

/// `YYYY-MM-DD` and nothing else.
pub(crate) fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Every day of the index with its totals, oldest first.
pub(crate) fn index_days(index: &xdev_kit::UsageIndex) -> Vec<DayTotals> {
    let mut days: std::collections::BTreeMap<&str, DayTotals> = std::collections::BTreeMap::new();
    for session in index.sessions.values() {
        for (day, t) in &session.days {
            let d = days.entry(day.as_str()).or_insert_with(|| DayTotals {
                day: day.clone(),
                ..DayTotals::default()
            });
            d.input = d.input.saturating_add(t.input);
            d.output = d.output.saturating_add(t.output);
            d.cache_read = d.cache_read.saturating_add(t.cache_read);
            d.cache_write = d.cache_write.saturating_add(t.cache_write);
        }
    }
    days.into_values().collect()
}

/// The oldest day of a session whose log file still exists: what the agent CLIs keep on disk.
/// `None` when no log is left.
pub(crate) fn cli_horizon(
    index: &xdev_kit::UsageIndex,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    index
        .files
        .iter()
        .filter(|(path, _)| exists(path))
        .filter_map(|(_, mark)| index.sessions.get(&mark.session))
        .filter_map(|s| s.days.keys().next())
        .min()
        .cloned()
}

/// `license_required` when `from_day` is before the oldest day the CLIs keep and Pro is not on.
pub(crate) fn check_range(
    from_day: &str,
    to_day: &str,
    horizon: Option<&str>,
    pro: bool,
) -> Result<(), CmdError> {
    if !is_day(from_day) || !is_day(to_day) || from_day > to_day {
        return Err(CmdError {
            code: "bad_arg",
            detail: Some("days".into()),
        });
    }
    let past = horizon.is_none_or(|h| from_day < h);
    if past && !pro {
        return Err(CmdError {
            code: "license_required",
            detail: Some(HISTORY_FEATURE.into()),
        });
    }
    Ok(())
}

/// The local day `utc_offset_minutes` east of UTC, `days_ago` days back from `now_ms`.
pub(crate) fn day_key(now_ms: i64, utc_offset_minutes: i32, days_ago: i64) -> String {
    let secs = now_ms.div_euclid(1000) + i64::from(utc_offset_minutes) * 60 - days_ago * 86_400;
    time::OffsetDateTime::from_unix_timestamp(secs)
        .map_or_else(|_| "0000-00-00".to_owned(), |t| t.date().to_string())
}

/// What is on disk, oldest first; a line that does not parse is skipped.
pub(crate) fn archive_read(path: &Path) -> Vec<DayTotals> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<ArchiveLine>(l).ok())
        .filter(|l| l.v == ARCHIVE_VERSION && is_day(&l.day))
        .map(|l| DayTotals {
            day: l.day,
            input: l.input,
            output: l.output,
            cache_read: l.cache_read,
            cache_write: l.cache_write,
        })
        .collect()
}

/// Appends the finished days (before `today`) that the archive does not hold yet. The file is
/// rewritten whole with the new lines at the end and swapped in, so a crash leaves the old file or
/// the new one. Returns how many days it added.
pub(crate) fn archive_append(
    path: &Path,
    days: &[DayTotals],
    today: &str,
) -> std::io::Result<usize> {
    let mut seen: std::collections::HashSet<String> =
        archive_read(path).into_iter().map(|d| d.day).collect();
    let mut fresh: Vec<&DayTotals> = Vec::new();
    for d in days {
        if d.day.as_str() < today && d.sum() > 0 && seen.insert(d.day.clone()) {
            fresh.push(d);
        }
    }
    if fresh.is_empty() {
        return Ok(0);
    }
    let mut bytes = std::fs::read(path).unwrap_or_default();
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    for d in &fresh {
        serde_json::to_writer(&mut bytes, &ArchiveLine::of(d)).map_err(std::io::Error::other)?;
        bytes.push(b'\n');
    }
    crate::atomic::write_atomic(path, &bytes)?;
    Ok(fresh.len())
}

/// Whether the archive already holds a day at or after `yesterday`; then there is nothing to do.
pub(crate) fn archive_current(path: &Path, yesterday: &str) -> bool {
    archive_read(path)
        .iter()
        .any(|d| d.day.as_str() >= yesterday)
}

/// The days `from_day..=to_day`: the archive's, plus the index's days the archive does not hold
/// yet (today, and anything before the first run). Oldest first.
pub(crate) fn range_of(
    archived: Vec<DayTotals>,
    indexed: Vec<DayTotals>,
    from_day: &str,
    to_day: &str,
) -> Vec<DayTotals> {
    let mut by_day: std::collections::BTreeMap<String, DayTotals> =
        std::collections::BTreeMap::new();
    // The archive goes last: its line wins.
    for d in indexed.into_iter().chain(archived) {
        by_day.insert(d.day.clone(), d);
    }
    by_day
        .into_values()
        .filter(|d| d.day.as_str() >= from_day && d.day.as_str() <= to_day)
        .collect()
}

/// Archives the finished days of the usage index, unless yesterday is already there. Reads the
/// session logs first. Runs on every plan; best effort.
fn archive_today(app: &tauri::AppHandle) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let Ok(local) = crate::accounts::local_dir(&state) else {
        return;
    };
    let path = local.join(ARCHIVE_FILE);
    let now = wall_now_ms();
    let Ok(ctx) = crate::kit::Ctx::of(&state) else {
        return;
    };
    // The index keeps the offset of the window that built it; before one did, UTC.
    let Ok(peek) = ctx.usage_index(false) else {
        return;
    };
    let offset = peek.utc_offset_minutes;
    if archive_current(&path, &day_key(now, offset, 1)) {
        return;
    }
    let Ok(index) = ctx.usage_index(true) else {
        return;
    };
    if let Err(e) = archive_append(&path, &index_days(&index), &day_key(now, offset, 0)) {
        eprintln!("usage archive: cannot write: {e}");
    }
}

/// Starts the daily archive: once at start, then every hour it checks whether a day finished.
pub fn start_archive(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            archive_today(&app);
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });
}

/// The days `from_day..=to_day` from the archive and the index. A range that starts before the
/// oldest day the agent CLIs keep needs Pro (`license_required`); a range inside it never does.
#[tauri::command(async)]
pub fn usage_archive(
    state: State<'_, AppState>,
    hub: State<'_, crate::license::LicenseHub>,
    from_day: String,
    to_day: String,
) -> Result<Vec<DayTotals>, CmdError> {
    let ctx = crate::kit::Ctx::of(&state)?;
    let index = ctx.usage_index(false)?;
    let horizon = cli_horizon(&index, |p| Path::new(p).exists());
    check_range(
        &from_day,
        &to_day,
        horizon.as_deref(),
        hub.allows(HISTORY_FEATURE),
    )?;
    let archived = crate::accounts::local_dir(&state)
        .map(|d| archive_read(&d.join(ARCHIVE_FILE)))
        .unwrap_or_default();
    Ok(range_of(archived, index_days(&index), &from_day, &to_day))
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

    #[test]
    fn busy_span_adds_elapsed() {
        let mut s = Stats::default();
        assert!(!s.busy("t", true, 1_000, 7));
        assert!(s.busy("t", false, 61_000, 8));
        assert_eq!(s.view(61_000).agent_busy_ms, 60_000);
        assert_eq!(s.view(0).since_ms, Some(7));
    }

    #[test]
    fn stop_without_start_counts_nothing() {
        let mut s = Stats::default();
        assert!(!s.busy("t", false, 5_000, 1));
        assert_eq!(s.view(5_000).agent_busy_ms, 0);
    }

    #[test]
    fn second_start_keeps_first_start() {
        let mut s = Stats::default();
        s.busy("t", true, 1_000, 1);
        s.busy("t", true, 9_000, 2);
        assert!(s.busy("t", false, 11_000, 3));
        assert_eq!(s.view(11_000).agent_busy_ms, 10_000);
    }

    #[test]
    fn span_is_capped_at_12h() {
        let mut s = Stats::default();
        s.busy("t", true, 0, 1);
        assert!(s.busy("t", false, BUSY_SPAN_CAP_MS * 3, 2));
        assert_eq!(s.view(0).agent_busy_ms, BUSY_SPAN_CAP_MS);
    }

    #[test]
    fn close_all_ends_every_live_span() {
        let mut s = Stats::default();
        s.busy("a", true, 0, 1);
        s.busy("b", true, 1_000, 1);
        assert!(s.close_all(4_000));
        assert_eq!(s.view(4_000).agent_busy_ms, 4_000 + 3_000);
        assert!(!s.close_all(5_000));
    }

    #[test]
    fn view_includes_running_spans() {
        let mut s = Stats::default();
        s.busy("t", true, 0, 1);
        assert_eq!(s.view(5_000).agent_busy_ms, 5_000);
        assert_eq!(s.saved.agent_busy_ms, 0);
    }

    #[test]
    fn live_map_over_1000_closes_oldest() {
        let mut s = Stats::default();
        for i in 0..1000u64 {
            s.busy(&format!("t{i}"), true, i, 1);
        }
        assert_eq!(s.live.len(), 1000);
        s.busy("extra", true, 5_000, 1);
        assert_eq!(s.live.len(), 1000);
        assert!(!s.live.contains_key("t0"));
        assert_eq!(s.saved.agent_busy_ms, 5_000);
    }

    #[test]
    fn hub_loads_lazily_and_saves_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let hub = AppStatsHub::default();
        assert!(!file(&dir).exists());
        hub.record_spawn(dir.path());
        hub.record_spawn(dir.path());
        assert_eq!(Stats::load(&file(&dir)).view(0).agents_started, 2);
        hub.record_pr(dir.path(), "https://x/pr/1");
        hub.record_pr(dir.path(), "https://x/pr/1");
        assert_eq!(Stats::load(&file(&dir)).view(0).prs_created, 1);
    }

    #[test]
    fn hub_close_all_without_load_is_a_noop() {
        AppStatsHub::default().close_all();
    }

    #[test]
    fn hub_busy_closes_a_span_and_saves() {
        let dir = tempfile::tempdir().unwrap();
        let hub = AppStatsHub::default();
        hub.busy(dir.path(), "t", true);
        assert!(!file(&dir).exists());
        hub.busy(dir.path(), "t", false);
        assert!(file(&dir).exists());
    }

    #[test]
    fn busy_command_rejects_empty_and_long_tab_ids() {
        assert!(!valid_tab_id(""));
        assert!(!valid_tab_id(&"a".repeat(TAB_ID_MAX + 1)));
        assert!(valid_tab_id("tab-1"));
        assert!(valid_tab_id(&"a".repeat(TAB_ID_MAX)));
    }

    #[test]
    fn counts_as_start_table() {
        assert!(counts_as_start(true, None, None));
        assert!(counts_as_start(true, None, Some(false)));
        assert!(!counts_as_start(true, Some("s1"), None));
        assert!(!counts_as_start(true, Some("s1"), Some(false)));
        assert!(counts_as_start(true, Some("s1"), Some(true)));
        assert!(!counts_as_start(false, None, None));
        assert!(!counts_as_start(false, Some("s1"), Some(true)));
    }
}

#[cfg(test)]
#[path = "app_stats_archive_tests.rs"]
mod archive_tests;
