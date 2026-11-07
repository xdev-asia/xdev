//! Copies a host's agent logs into a local mirror, so the session index can
//! read them like local files.
//!
//! `plan_sync` is pure: it compares what the host has with what the mirror
//! holds and says what to fetch or drop. `list_logs` and `apply` do the IO
//! through a small `LogSource`, which `Sftp` implements and tests fake.

use std::collections::HashMap;
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::rpath::RemoteError;
use crate::sftp::{CHUNK, EntryKind, OPEN_READ, Sftp};

/// A log on the host, `rel` to the agent home (`projects/x/y.jsonl`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLog {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// A log in the mirror; `mtime_ms` is the host's mtime it was copied at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirroredLog {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncCaps {
    /// Files older than this are neither fetched nor kept.
    pub since_ms: u64,
    /// The most bytes one sync fetches.
    pub budget: u64,
    /// The most bytes the mirror holds.
    pub host_cap: u64,
    /// Files larger than this are skipped.
    pub file_cap: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchStep {
    Append { rel: String, from: u64, len: u64 },
    Whole { rel: String, len: u64 },
    Evict { rel: String },
}

impl FetchStep {
    fn bytes(&self) -> u64 {
        match self {
            FetchStep::Append { len, .. } | FetchStep::Whole { len, .. } => *len,
            FetchStep::Evict { .. } => 0,
        }
    }
}

/// Whether `rel` stays inside the mirror: relative, `/`-separated, no `..`.
pub fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains(['\\', '\0', ':'])
        && rel
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// What to do so the mirror matches the host, newest files first. The flag is
/// set when the budget stopped the plan; the next sync continues.
pub fn plan_sync(
    remote: &[RemoteLog],
    mirror: &[MirroredLog],
    caps: &SyncCaps,
) -> (Vec<FetchStep>, bool) {
    let have: HashMap<&str, &MirroredLog> = mirror
        .iter()
        .filter(|m| safe_rel(&m.rel))
        .map(|m| (m.rel.as_str(), m))
        .collect();
    let mut steps = Vec::new();

    // Past the retention window: drop from the mirror.
    for m in mirror
        .iter()
        .filter(|m| safe_rel(&m.rel) && m.mtime_ms < caps.since_ms)
    {
        steps.push(FetchStep::Evict { rel: m.rel.clone() });
    }

    let mut fresh: Vec<&RemoteLog> = remote
        .iter()
        .filter(|r| safe_rel(&r.rel) && r.mtime_ms >= caps.since_ms && r.size <= caps.file_cap)
        .collect();
    fresh.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then_with(|| a.rel.cmp(&b.rel)));

    let mut fetched = Vec::new();
    let mut used = 0u64;
    let mut capped = false;
    for r in fresh {
        let step = match have.get(r.rel.as_str()) {
            None => FetchStep::Whole {
                rel: r.rel.clone(),
                len: r.size,
            },
            Some(m) if m.size > r.size => FetchStep::Whole {
                rel: r.rel.clone(),
                len: r.size,
            },
            Some(m) if m.size == r.size => continue,
            Some(m) if r.mtime_ms <= m.mtime_ms => continue,
            Some(m) => FetchStep::Append {
                rel: r.rel.clone(),
                from: m.size,
                len: r.size - m.size,
            },
        };
        // The first step always runs, so a file bigger than the budget still arrives.
        if used > 0 && used + step.bytes() > caps.budget {
            capped = true;
            break;
        }
        used += step.bytes();
        fetched.push(step);
    }
    if used > caps.budget {
        capped = true;
    }

    // Keep the mirror under its cap: oldest files go first, never one being fetched.
    let mut size: u64 = have.values().map(|m| m.size).sum();
    for step in &fetched {
        match step {
            FetchStep::Whole { rel, len } => {
                size = size - have.get(rel.as_str()).map_or(0, |m| m.size) + len;
            }
            FetchStep::Append { len, .. } => size += len,
            FetchStep::Evict { .. } => {}
        }
    }
    for e in &steps {
        if let FetchStep::Evict { rel } = e {
            size = size.saturating_sub(have.get(rel.as_str()).map_or(0, |m| m.size));
        }
    }
    if size > caps.host_cap {
        let keep: Vec<&str> = fetched
            .iter()
            .filter_map(|s| match s {
                FetchStep::Append { rel, .. } | FetchStep::Whole { rel, .. } => Some(rel.as_str()),
                FetchStep::Evict { .. } => None,
            })
            .collect();
        let mut old: Vec<&&MirroredLog> = have
            .values()
            .filter(|m| m.mtime_ms >= caps.since_ms && !keep.contains(&m.rel.as_str()))
            .collect();
        old.sort_by(|a, b| a.mtime_ms.cmp(&b.mtime_ms).then_with(|| a.rel.cmp(&b.rel)));
        for m in old {
            if size <= caps.host_cap {
                break;
            }
            size -= m.size;
            steps.push(FetchStep::Evict { rel: m.rel.clone() });
        }
    }
    steps.extend(fetched);
    (steps, capped)
}

/// One item of a host folder: name, kind, size, mtime in ms.
pub type LogEntry = (String, EntryKind, u64, u64);

/// The two calls the driver needs from a host.
pub trait LogSource {
    /// The items of a folder; `NotFound` when absent.
    fn list(&mut self, dir: &str) -> Result<Vec<LogEntry>, RemoteError>;
    /// Up to `len` bytes at `offset`; empty at the end.
    fn read_at(&mut self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, RemoteError>;
}

impl<W: Write> LogSource for Sftp<W> {
    fn list(&mut self, dir: &str) -> Result<Vec<LogEntry>, RemoteError> {
        Ok(self
            .read_dir(dir)?
            .into_iter()
            .map(|e| (e.name, e.kind, e.size, u64::from(e.mtime) * 1000))
            .collect())
    }

    fn read_at(&mut self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, RemoteError> {
        let handle = self.open(path, OPEN_READ, None)?;
        let mut out = Vec::new();
        let got = (|| {
            while (out.len() as u64) < len {
                let want = (len - out.len() as u64).min(u64::from(CHUNK)) as u32;
                match self.read(&handle, offset + out.len() as u64, want)? {
                    Some(c) if !c.is_empty() => out.extend_from_slice(&c),
                    _ => break,
                }
            }
            Ok::<(), RemoteError>(())
        })();
        let closed = self.close(&handle);
        got?;
        closed?;
        Ok(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLayout {
    /// `projects/*/*.jsonl`
    Claude,
    /// `sessions/YYYY/MM/DD/rollout-*.jsonl`; date folders older than `since` are skipped.
    Codex,
}

/// The logs under `root` (an agent home), newest data only. An absent home or
/// folder lists nothing.
pub fn list_logs<S: LogSource + ?Sized>(
    src: &mut S,
    root: &str,
    layout: LogLayout,
    since_ms: u64,
) -> Result<Vec<RemoteLog>, RemoteError> {
    let root = root.trim_end_matches('/');
    let mut out = Vec::new();
    match layout {
        LogLayout::Claude => {
            for (proj, ..) in dirs(src, root, "projects")? {
                let rel_dir = format!("projects/{proj}");
                push_files(src, root, &rel_dir, |n| n.ends_with(".jsonl"), &mut out)?;
            }
        }
        LogLayout::Codex => {
            let since_day = day_of(since_ms);
            for (y, ..) in dirs(src, root, "sessions")? {
                let Ok(yn) = y.parse::<i64>() else { continue };
                if (yn, 12, 31) < since_day {
                    continue;
                }
                for (m, ..) in dirs(src, root, &format!("sessions/{y}"))? {
                    let Ok(mn) = m.parse::<i64>() else { continue };
                    if (yn, mn, 31) < since_day {
                        continue;
                    }
                    for (d, ..) in dirs(src, root, &format!("sessions/{y}/{m}"))? {
                        let Ok(dn) = d.parse::<i64>() else { continue };
                        if (yn, mn, dn) < since_day {
                            continue;
                        }
                        let rel_dir = format!("sessions/{y}/{m}/{d}");
                        let wanted = |n: &str| n.starts_with("rollout-") && n.ends_with(".jsonl");
                        push_files(src, root, &rel_dir, wanted, &mut out)?;
                    }
                }
            }
        }
    }
    out.retain(|l| l.mtime_ms >= since_ms);
    Ok(out)
}

fn push_files<S: LogSource + ?Sized>(
    src: &mut S,
    root: &str,
    rel_dir: &str,
    wanted: impl Fn(&str) -> bool,
    out: &mut Vec<RemoteLog>,
) -> Result<(), RemoteError> {
    for (name, kind, size, mtime_ms) in list_or_empty(src, &format!("{root}/{rel_dir}"))? {
        if kind == EntryKind::File && wanted(&name) {
            out.push(RemoteLog {
                rel: format!("{rel_dir}/{name}"),
                size,
                mtime_ms,
            });
        }
    }
    Ok(())
}

fn list_or_empty<S: LogSource + ?Sized>(
    src: &mut S,
    dir: &str,
) -> Result<Vec<LogEntry>, RemoteError> {
    match src.list(dir) {
        Err(RemoteError::NotFound | RemoteError::Denied) => Ok(Vec::new()),
        other => other,
    }
}

fn dirs<S: LogSource + ?Sized>(
    src: &mut S,
    root: &str,
    rel: &str,
) -> Result<Vec<LogEntry>, RemoteError> {
    let mut v = list_or_empty(src, &format!("{root}/{rel}"))?;
    v.retain(|e| e.1 == EntryKind::Dir);
    Ok(v)
}

/// `(year, month, day)` of a Unix time in ms, UTC, one day earlier so a
/// timezone difference never hides a folder.
fn day_of(ms: u64) -> (i64, i64, i64) {
    let days = (ms / 86_400_000) as i64 - 1;
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// The files of `dest` as the planner sees them: `rel`, size and mtime.
pub fn scan_mirror(dest: &Path) -> Vec<MirroredLog> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<MirroredLog>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if meta.is_dir() {
                walk(&e.path(), &rel, out);
            } else if meta.is_file() {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                out.push(MirroredLog {
                    rel,
                    size: meta.len(),
                    mtime_ms,
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(dest, "", &mut out);
    out
}

/// Runs the steps: files land under `dest` at their `rel`. Returns the bytes
/// fetched. `mtimes` gives each fetched file the host's mtime.
pub fn apply<S: LogSource + ?Sized>(
    src: &mut S,
    root: &str,
    dest: &Path,
    steps: &[FetchStep],
    mtimes: &HashMap<String, u64>,
) -> Result<u64, RemoteError> {
    let root = root.trim_end_matches('/');
    let io = |e: std::io::Error| RemoteError::Io(e.to_string());
    let mut total = 0;
    for step in steps {
        match step {
            FetchStep::Evict { rel } => {
                if safe_rel(rel) {
                    let _ = fs::remove_file(dest.join(rel));
                }
            }
            FetchStep::Whole { rel, len } | FetchStep::Append { rel, len, .. } => {
                if !safe_rel(rel) {
                    return Err(RemoteError::BadPath(rel.clone()));
                }
                let from = match step {
                    FetchStep::Append { from, .. } => *from,
                    _ => 0,
                };
                let path: PathBuf = dest.join(rel);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(io)?;
                }
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(from == 0)
                    .open(&path)
                    .map_err(io)?;
                file.seek(SeekFrom::Start(from)).map_err(io)?;
                let mut done = 0u64;
                while done < *len {
                    let want = (*len - done).min(1 << 20);
                    let chunk = src.read_at(&format!("{root}/{rel}"), from + done, want)?;
                    if chunk.is_empty() {
                        break;
                    }
                    file.write_all(&chunk).map_err(io)?;
                    done += chunk.len() as u64;
                }
                total += done;
                if let Some(ms) = mtimes.get(rel) {
                    let _ = file.set_modified(UNIX_EPOCH + Duration::from_millis(*ms));
                }
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400_000;

    fn caps() -> SyncCaps {
        SyncCaps {
            since_ms: 1_000,
            budget: 1 << 20,
            host_cap: 1 << 30,
            file_cap: 1 << 20,
        }
    }

    fn r(rel: &str, size: u64, mtime_ms: u64) -> RemoteLog {
        RemoteLog {
            rel: rel.into(),
            size,
            mtime_ms,
        }
    }

    fn m(rel: &str, size: u64, mtime_ms: u64) -> MirroredLog {
        MirroredLog {
            rel: rel.into(),
            size,
            mtime_ms,
        }
    }

    fn whole(rel: &str, len: u64) -> FetchStep {
        FetchStep::Whole {
            rel: rel.into(),
            len,
        }
    }

    #[test]
    fn a_new_file_in_the_window_is_fetched_whole_an_old_one_is_not() {
        let (steps, capped) = plan_sync(&[r("a", 10, 5_000), r("b", 10, 500)], &[], &caps());
        assert_eq!(steps, [whole("a", 10)]);
        assert!(!capped);
    }

    #[test]
    fn a_grown_file_appends_a_shrunk_one_restarts_an_unchanged_one_is_left() {
        let mirror = [
            m("grow", 4, 2_000),
            m("shrink", 9, 2_000),
            m("same", 5, 2_000),
        ];
        let remote = [
            r("grow", 10, 3_000),
            r("shrink", 3, 3_000),
            r("same", 5, 3_000),
        ];
        let (steps, _) = plan_sync(&remote, &mirror, &caps());
        assert_eq!(steps.len(), 2);
        assert!(steps.contains(&FetchStep::Append {
            rel: "grow".into(),
            from: 4,
            len: 6
        }));
        assert!(steps.contains(&whole("shrink", 3)));
    }

    #[test]
    fn a_larger_file_with_an_old_mtime_is_left() {
        let (steps, _) = plan_sync(&[r("a", 10, 2_000)], &[m("a", 4, 2_000)], &caps());
        assert!(steps.is_empty());
    }

    #[test]
    fn the_budget_stops_planning_and_keeps_newest_first() {
        let mut c = caps();
        c.budget = 25;
        let remote = [
            r("old", 10, 2_000),
            r("new", 10, 4_000),
            r("mid", 10, 3_000),
        ];
        let (steps, capped) = plan_sync(&remote, &[], &c);
        assert_eq!(steps, [whole("new", 10), whole("mid", 10)]);
        assert!(capped);
    }

    #[test]
    fn a_file_bigger_than_the_budget_still_goes_first() {
        let mut c = caps();
        c.budget = 5;
        let (steps, capped) = plan_sync(&[r("a", 10, 2_000), r("b", 1, 1_500)], &[], &c);
        assert_eq!(steps, [whole("a", 10)]);
        assert!(capped);
    }

    #[test]
    fn the_host_cap_evicts_the_oldest_mirrored_files_first() {
        let mut c = caps();
        c.host_cap = 25;
        let mirror = [m("o1", 10, 2_000), m("o2", 10, 3_000), m("o3", 10, 4_000)];
        let (steps, _) = plan_sync(&[r("n", 10, 9_000)], &mirror, &c);
        assert_eq!(
            steps,
            [
                FetchStep::Evict { rel: "o1".into() },
                FetchStep::Evict { rel: "o2".into() },
                whole("n", 10)
            ]
        );
    }

    #[test]
    fn mirrored_files_past_the_window_are_dropped() {
        let (steps, _) = plan_sync(&[], &[m("gone", 3, 10)], &caps());
        assert_eq!(steps, [FetchStep::Evict { rel: "gone".into() }]);
    }

    #[test]
    fn a_file_over_the_file_cap_is_skipped() {
        let mut c = caps();
        c.file_cap = 5;
        let (steps, _) = plan_sync(&[r("big", 6, 2_000), r("ok", 5, 2_000)], &[], &c);
        assert_eq!(steps, [whole("ok", 5)]);
    }

    #[test]
    fn a_rel_that_could_leave_the_mirror_is_rejected() {
        for bad in [
            "../x", "a/../x", "/abs", "a\\b", "a//b", "", "./a", "C:/x", "a\0b",
        ] {
            assert!(!safe_rel(bad), "{bad:?}");
            let (steps, _) = plan_sync(&[r(bad, 1, 2_000)], &[], &caps());
            assert!(steps.is_empty(), "{bad:?}");
        }
        assert!(safe_rel("projects/p/s.jsonl"));
    }

    #[test]
    fn day_of_is_the_day_before_the_instant() {
        // 20_000 days after 1970-01-01 is 2024-10-04.
        assert_eq!(day_of(20_000 * DAY), (2024, 10, 3));
        assert_eq!(day_of(DAY), (1970, 1, 1));
        assert_eq!(day_of(0), (1969, 12, 31));
    }
}
