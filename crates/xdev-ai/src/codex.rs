use std::cmp::Reverse;
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::AiError;
use crate::claude::{AccountStatus, StatusState, find_cli, stdout_within};
use crate::codex_rpc::ProbeError;
use crate::process::{kill_tree, own_group};
use crate::quota::QuotaWindow;

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
/// `codex debug models` carries each model's prompts: hundreds of KiB.
const MODELS_MAX: u64 = 16 << 20;
/// Sessions with no rate-limit line (an API-key run, a crash before the
/// first turn) are skipped, but only this many: an old file says little.
const MAX_FILES: usize = 10;
/// A live result younger than this is reused, so the Accounts view and the
/// footer do not spawn twice.
#[allow(dead_code)]
pub(crate) const LIVE_REUSE: Duration = Duration::from_secs(60);
const FIVE_HOURS: u64 = 300;
const SEVEN_DAYS: u64 = 10_080;

/// `XDEV_CODEX_BIN`, else `codex` on `PATH`; on Windows `codex.exe`, then
/// npm's `codex.cmd`.
pub fn codex_command() -> Result<Command, AiError> {
    find_cli("XDEV_CODEX_BIN", "codex", AiError::NoCodex)
}

/// The slugs `codex debug models` offers for picking, in its order; the ones
/// it marks hidden are left out.
pub fn codex_models() -> Result<Vec<String>, AiError> {
    let mut cmd = codex_command()?;
    cmd.args(["debug", "models"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(parse_models(&stdout_within(
        cmd,
        STATUS_TIMEOUT,
        MODELS_MAX,
    )?))
}

pub(crate) fn parse_models(out: &[u8]) -> Vec<String> {
    let Ok(catalog) = serde_json::from_slice::<Value>(out) else {
        return Vec::new();
    };
    catalog
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(Value::as_str) != Some("hide"))
        .filter_map(|m| m.get("slug").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// Sign-in state from the exit code of `codex login status`; 0.165 prints
/// no email or plan in a form worth parsing.
pub(crate) fn status(dir: &Path) -> AccountStatus {
    let Ok(mut cmd) = codex_command() else {
        return AccountStatus::bare(StatusState::NoCodex);
    };
    cmd.args(["login", "status"])
        .env("CODEX_HOME", dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match exit_within(cmd, STATUS_TIMEOUT) {
        Ok(exit) if exit.success() => AccountStatus::bare(StatusState::LoggedIn),
        Ok(_) => AccountStatus::bare(StatusState::LoggedOut),
        Err(e) if e.kind() == io::ErrorKind::NotFound => AccountStatus::bare(StatusState::NoCodex),
        Err(_) => AccountStatus::bare(StatusState::Error),
    }
}

/// Live read for one Codex home: one probe at a time per home, a result
/// reused for `LIVE_REUSE`.
#[allow(dead_code)]
pub(crate) fn live_usage(_dir: &Path) -> Result<Vec<QuotaWindow>, ProbeError> {
    Err(ProbeError::Timeout)
}

fn exit_within(mut cmd: Command, timeout: Duration) -> io::Result<ExitStatus> {
    own_group(&mut cmd);
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(exit) = child.try_wait()? {
            return Ok(exit);
        }
        if Instant::now() >= deadline {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::ErrorKind::TimedOut.into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// What the newest session file says about the account's limits.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Usage {
    pub windows: Vec<QuotaWindow>,
    pub as_of: String,
}

/// Codex has no usage endpoint xDev may call; every turn writes the
/// limits it was given into the session file, so the newest one is the
/// freshest reading there is. `None` when no session has any.
pub(crate) fn usage(dir: &Path, now: SystemTime) -> Option<Usage> {
    let mut files = Vec::new();
    collect_jsonl(&dir.join("sessions"), &mut files);
    files.sort_by_key(|(modified, _)| Reverse(*modified));
    let now = unix(now);
    files
        .iter()
        .take(MAX_FILES)
        .find_map(|(modified, path)| read_session(path, *modified, now))
}

fn collect_jsonl(dir: &Path, out: &mut Vec<(SystemTime, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            collect_jsonl(&path, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            out.push((modified, path));
        }
    }
}

fn read_session(path: &Path, modified: SystemTime, now: i64) -> Option<Usage> {
    let file = File::open(path).ok()?;
    let mut last = None;
    // Lines are parsed one at a time: session files reach megabytes, and
    // only the last rate-limit line counts.
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = &event["payload"];
        if payload["type"] != "token_count" || !payload["rate_limits"].is_object() {
            continue;
        }
        let windows = parse_rate_limits(&payload["rate_limits"], now);
        let as_of = event["timestamp"].as_str().map(str::to_owned);
        last = Some((windows, as_of));
    }
    let (windows, as_of) = last?;
    Some(Usage {
        windows,
        as_of: as_of.unwrap_or_else(|| rfc3339(unix(modified))),
    })
}

/// The folder Codex keeps its sessions in: the account's, else
/// `CODEX_HOME`, else `~/.codex`.
pub fn codex_home(account_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = account_dir {
        return Some(dir.to_path_buf());
    }
    if let Some(home) = env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(home));
    }
    let user = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|h| !h.is_empty())?;
    Some(PathBuf::from(user).join(".codex"))
}

/// Tokens the session's last turn sent and its model's context window,
/// from the session file. `codex exec --json` reports neither.
pub fn codex_context(home: &Path, session_id: &str) -> Option<(u64, u64)> {
    let suffix = format!("-{session_id}.jsonl");
    let mut files = Vec::new();
    collect_jsonl(&home.join("sessions"), &mut files);
    files.sort_by_key(|(modified, _)| Reverse(*modified));
    let (_, path) = files.iter().find(|(_, p)| {
        p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(&suffix))
    })?;
    let mut last = None;
    for line in BufReader::new(File::open(path).ok()?).lines() {
        let Ok(line) = line else { break };
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let info = &event["payload"]["info"];
        if event["payload"]["type"] != "token_count" {
            continue;
        }
        if let (Some(used), Some(window)) = (
            info["last_token_usage"]["input_tokens"].as_u64(),
            info["model_context_window"].as_u64(),
        ) {
            last = Some((used, window));
        }
    }
    last
}

/// `primary` and `secondary` get Claude's names when their length matches,
/// so the UI labels them the same way.
pub(crate) fn parse_rate_limits(limits: &Value, now: i64) -> Vec<QuotaWindow> {
    [
        ("primary", FIVE_HOURS, "five_hour"),
        ("secondary", SEVEN_DAYS, "seven_day"),
    ]
    .into_iter()
    .filter_map(|(slot, minutes, known)| {
        let window = limits.get(slot)?.as_object()?;
        let key = if window.get("window_minutes").and_then(Value::as_u64) == Some(minutes) {
            known
        } else {
            slot
        };
        let resets_at = window.get("resets_at").and_then(Value::as_i64);
        // The reading predates the reset, so what it counted is gone.
        let rolled_over = resets_at.is_some_and(|at| at <= now);
        Some(QuotaWindow {
            key: key.to_owned(),
            utilization: if rolled_over {
                Some(0.0)
            } else {
                window.get("used_percent").and_then(Value::as_f64)
            },
            resets_at: resets_at.filter(|_| !rolled_over).map(rfc3339),
        })
    })
    .collect()
}

fn unix(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
pub(crate) fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to a
/// proleptic Gregorian date.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_skip_hidden_ones() {
        let out = br#"{"models":[{"slug":"gpt-a","visibility":"list"},{"slug":"gpt-b","visibility":"hide"},{"slug":"gpt-c"}]}"#;
        assert_eq!(parse_models(out), ["gpt-a", "gpt-c"]);
        assert!(parse_models(b"not json").is_empty());
    }

    #[test]
    fn rfc3339_formats_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_793_600_936), "2026-11-02T06:28:56Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn rate_limits_map_known_lengths_and_roll_over() {
        let limits = serde_json::json!({
            "primary": {"used_percent": 37.0, "window_minutes": 300, "resets_at": 2_000},
            "secondary": {"used_percent": 80.5, "window_minutes": 1440, "resets_at": 500},
            "plan_type": "plus"
        });
        let windows = parse_rate_limits(&limits, 1_000);
        assert_eq!(
            windows,
            vec![
                QuotaWindow {
                    key: "five_hour".into(),
                    utilization: Some(37.0),
                    resets_at: Some(rfc3339(2_000)),
                },
                QuotaWindow {
                    key: "secondary".into(),
                    utilization: Some(0.0),
                    resets_at: None,
                },
            ]
        );
    }

    #[test]
    fn rate_limits_skip_missing_slots() {
        let limits = serde_json::json!({"primary": null, "credits": {"balance": 1}});
        assert!(parse_rate_limits(&limits, 0).is_empty());
    }
}
