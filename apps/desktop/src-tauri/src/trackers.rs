//! Task trackers: Linear and Jira next to GitHub issues. Read-only.
//!
//! Tokens live only in the OS keychain (`xdev_tracker::keys`). The non-secret setup (account
//! name, Jira base, checklists) is in its own `trackers.json`, not `settings.json`, so the
//! diagnostics bundle never sees it. No error carries a token, a URL or a reply body.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use xdev_tracker::http::{HttpSend, Secret};
use xdev_tracker::jira::{JiraConn, jira_list, jira_myself};
use xdev_tracker::keys::{Keychain, TrackerKeys};
use xdev_tracker::linear::{linear_list, linear_viewer};
use xdev_tracker::ureq_http::UreqHttp;
use xdev_tracker::urls::{host_of, jira_cloud_base, jira_server_base};
use xdev_tracker::{
    JiraMode, TOKEN_MAX, TaskSource, TrackerError, TrackerKind, TrackerList, TrackerPulls,
};

use crate::atomic::write_atomic;
use crate::commands::CmdError;

const FILE_NAME: &str = "trackers.json";
const LINEAR_HOST: &str = "api.linear.app";
const DONE_DAYS: i64 = 30;

impl From<TrackerError> for CmdError {
    fn from(e: TrackerError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: e.detail(),
        }
    }
}

fn io_err() -> CmdError {
    CmdError {
        code: "io",
        detail: None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ConnectKind {
    Linear,
    JiraCloud,
    JiraServer,
}

#[derive(Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TrackerConnect {
    pub kind: ConnectKind,
    /// Empty for Linear.
    pub url: String,
    /// Empty unless Jira Cloud.
    pub email: String,
    pub token: String,
}

// A manual `Debug` so a logged input never carries the token.
impl std::fmt::Debug for TrackerConnect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrackerConnect")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LinearView {
    pub connected: bool,
    pub account: Option<String>,
    pub pulls: TrackerPulls,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct JiraView {
    pub connected: bool,
    pub account: Option<String>,
    pub mode: Option<JiraMode>,
    pub base: Option<String>,
    pub email: Option<String>,
    pub pulls: TrackerPulls,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TrackersView {
    pub github: TrackerPulls,
    pub linear: LinearView,
    pub jira: JiraView,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct LinearCfg {
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    pulls: TrackerPulls,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct JiraCfg {
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    mode: Option<JiraMode>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    pulls: TrackerPulls,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
struct Config {
    github: TrackerPulls,
    linear: LinearCfg,
    jira: JiraCfg,
}

/// One section that fails to parse falls back to its defaults; the others are kept.
fn section<T: for<'de> Deserialize<'de> + Default>(root: &serde_json::Value, name: &str) -> T {
    root.get(name)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn load(path: &Path) -> Config {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Config::default();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Config::default();
    };
    Config {
        github: section(&root, "github"),
        linear: section(&root, "linear"),
        jira: section(&root, "jira"),
    }
}

fn save(path: &Path, cfg: &Config) -> Result<(), CmdError> {
    let text = serde_json::to_string_pretty(cfg).map_err(|_| io_err())?;
    write_atomic(path, text.as_bytes()).map_err(|_| io_err())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, CmdError> {
    app.path()
        .app_config_dir()
        .map(|d| d.join(FILE_NAME))
        .map_err(|_| io_err())
}

fn jira_conn(cfg: &JiraCfg) -> Option<JiraConn> {
    Some(JiraConn {
        mode: cfg.mode?,
        base: cfg.base.clone()?,
        email: cfg.email.clone(),
    })
}

/// The key for Jira only when it is bound to the configured host.
fn jira_key(cfg: &JiraCfg, keys: &dyn TrackerKeys) -> Option<Secret> {
    let host = host_of(cfg.base.as_deref()?)?;
    keys.get(TrackerKind::Jira, &host).ok().flatten()
}

fn linear_key(keys: &dyn TrackerKeys) -> Option<Secret> {
    keys.get(TrackerKind::Linear, LINEAR_HOST).ok().flatten()
}

fn view(cfg: &Config, keys: &dyn TrackerKeys) -> TrackersView {
    let linear_on = cfg.linear.account.is_some() && linear_key(keys).is_some();
    let jira_on = cfg.jira.account.is_some() && jira_key(&cfg.jira, keys).is_some();
    TrackersView {
        github: cfg.github,
        linear: LinearView {
            connected: linear_on,
            account: cfg.linear.account.clone().filter(|_| linear_on),
            pulls: cfg.linear.pulls,
        },
        jira: JiraView {
            connected: jira_on,
            account: cfg.jira.account.clone().filter(|_| jira_on),
            mode: cfg.jira.mode.filter(|_| jira_on),
            base: cfg.jira.base.clone().filter(|_| jira_on),
            email: cfg.jira.email.clone().filter(|_| jira_on),
            pulls: cfg.jira.pulls,
        },
    }
}

fn status_with(path: &Path, keys: &dyn TrackerKeys) -> TrackersView {
    view(&load(path), keys)
}

fn connect_with(
    path: &Path,
    keys: &dyn TrackerKeys,
    http: &dyn HttpSend,
    input: &TrackerConnect,
) -> Result<TrackersView, CmdError> {
    let token = input.token.trim();
    if token.is_empty() {
        return Err(TrackerError::EmptyKey.into());
    }
    if token.chars().count() > TOKEN_MAX {
        return Err(TrackerError::TooLarge.into());
    }
    let secret = Secret::new(token);
    let mut cfg = load(path);
    let (kind, host) = match input.kind {
        ConnectKind::Linear => {
            let name = linear_viewer(http, &secret)?;
            cfg.linear.account = Some(name);
            (TrackerKind::Linear, LINEAR_HOST.to_owned())
        }
        ConnectKind::JiraCloud | ConnectKind::JiraServer => {
            let cloud = input.kind == ConnectKind::JiraCloud;
            let base = if cloud {
                jira_cloud_base(&input.url)?
            } else {
                jira_server_base(&input.url)?
            };
            let email = input.email.trim();
            if cloud && email.is_empty() {
                return Err(TrackerError::EmptyKey.into());
            }
            let conn = JiraConn {
                mode: if cloud {
                    JiraMode::Cloud
                } else {
                    JiraMode::Server
                },
                base: base.clone(),
                email: cloud.then(|| email.to_owned()),
            };
            let name = jira_myself(http, &conn, &secret)?;
            cfg.jira.account = Some(name);
            cfg.jira.mode = Some(conn.mode);
            cfg.jira.base = Some(base.clone());
            cfg.jira.email = conn.email;
            (
                TrackerKind::Jira,
                host_of(&base).ok_or(TrackerError::BadUrl)?,
            )
        }
    };
    // The call worked: store the key, then the setup. A failed write undoes the key.
    keys.set(kind, &host, token)?;
    if let Err(e) = save(path, &cfg) {
        let _ = keys.remove(kind);
        return Err(e);
    }
    Ok(view(&cfg, keys))
}

fn disconnect_with(
    path: &Path,
    keys: &dyn TrackerKeys,
    kind: TrackerKind,
) -> Result<TrackersView, CmdError> {
    keys.remove(kind)?;
    let mut cfg = load(path);
    match kind {
        TrackerKind::Linear => cfg.linear.account = None,
        TrackerKind::Jira => {
            cfg.jira = JiraCfg {
                pulls: cfg.jira.pulls,
                ..JiraCfg::default()
            }
        }
    }
    save(path, &cfg)?;
    Ok(view(&cfg, keys))
}

fn pulls_set_with(
    path: &Path,
    keys: &dyn TrackerKeys,
    source: TaskSource,
    pulls: TrackerPulls,
) -> Result<TrackersView, CmdError> {
    let mut cfg = load(path);
    let pulls = pulls.normalized();
    match source {
        TaskSource::Github => cfg.github = pulls,
        TaskSource::Linear => cfg.linear.pulls = pulls,
        TaskSource::Jira => cfg.jira.pulls = pulls,
    }
    save(path, &cfg)?;
    Ok(view(&cfg, keys))
}

fn since(now_unix: i64) -> String {
    OffsetDateTime::from_unix_timestamp(now_unix - DONE_DAYS * 86_400)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_default()
}

fn list_with(
    path: &Path,
    keys: &dyn TrackerKeys,
    http: &dyn HttpSend,
    now_unix: i64,
    kind: TrackerKind,
) -> Result<TrackerList, CmdError> {
    let cfg = load(path);
    match kind {
        TrackerKind::Linear => {
            if cfg.linear.account.is_none() {
                return Err(TrackerError::NotConfigured.into());
            }
            let key = linear_key(keys).ok_or(TrackerError::NotConfigured)?;
            Ok(linear_list(
                http,
                &key,
                &cfg.linear.pulls,
                &since(now_unix),
            )?)
        }
        TrackerKind::Jira => {
            let conn = jira_conn(&cfg.jira).ok_or(TrackerError::NotConfigured)?;
            let key = jira_key(&cfg.jira, keys).ok_or(TrackerError::NotConfigured)?;
            Ok(jira_list(http, &conn, &key, &cfg.jira.pulls)?)
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

#[tauri::command(async)]
pub fn trackers_status(app: AppHandle) -> Result<TrackersView, CmdError> {
    Ok(status_with(&config_path(&app)?, &Keychain))
}

#[tauri::command(async)]
pub fn tracker_connect(app: AppHandle, input: TrackerConnect) -> Result<TrackersView, CmdError> {
    connect_with(&config_path(&app)?, &Keychain, &UreqHttp, &input)
}

#[tauri::command(async)]
pub fn tracker_disconnect(app: AppHandle, kind: TrackerKind) -> Result<TrackersView, CmdError> {
    disconnect_with(&config_path(&app)?, &Keychain, kind)
}

#[tauri::command(async)]
pub fn tracker_pulls_set(
    app: AppHandle,
    source: TaskSource,
    pulls: TrackerPulls,
) -> Result<TrackersView, CmdError> {
    pulls_set_with(&config_path(&app)?, &Keychain, source, pulls)
}

#[tauri::command(async)]
pub fn tracker_list(app: AppHandle, kind: TrackerKind) -> Result<TrackerList, CmdError> {
    list_with(&config_path(&app)?, &Keychain, &UreqHttp, now_unix(), kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_tracker::http::FakeHttp;
    use xdev_tracker::keys::MemoryKeys;

    const VIEWER: &str =
        include_str!("../../../../crates/xdev-tracker/tests/fixtures/linear_viewer.json");
    const MYSELF: &str =
        include_str!("../../../../crates/xdev-tracker/tests/fixtures/jira_myself.json");
    const ISSUES: &str =
        include_str!("../../../../crates/xdev-tracker/tests/fixtures/linear_issues_p2.json");
    const NOW: i64 = 1_793_000_000;

    fn cfg_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join(FILE_NAME)
    }

    fn input(kind: ConnectKind, url: &str, email: &str, token: &str) -> TrackerConnect {
        TrackerConnect {
            kind,
            url: url.into(),
            email: email.into(),
            token: token.into(),
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let v = status_with(&cfg_path(&dir), &MemoryKeys::new());
        assert_eq!(v.github, TrackerPulls::default());
        assert!(!v.linear.connected && !v.jira.connected);
        assert_eq!(v.linear.pulls, TrackerPulls::default());
    }

    #[test]
    fn bad_file_or_section_falls_back_per_section() {
        let dir = tempfile::tempdir().unwrap();
        let p = cfg_path(&dir);
        std::fs::write(&p, "{bad").unwrap();
        assert_eq!(load(&p), Config::default());
        std::fs::write(
            &p,
            r#"{"github":{"assigned":"yes"},"linear":{"account":"Ada","pulls":{"assigned":false,"created":true,"done":true}},"jira":7}"#,
        )
        .unwrap();
        let c = load(&p);
        assert_eq!(c.github, TrackerPulls::default());
        assert_eq!(c.linear.account.as_deref(), Some("Ada"));
        assert!(c.linear.pulls.created && c.linear.pulls.done);
        assert_eq!(c.jira, JiraCfg::default());
    }

    #[test]
    fn save_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let p = cfg_path(&dir);
        let mut c = Config::default();
        c.linear.account = Some("Ada".into());
        c.jira.base = Some("https://acme.atlassian.net".into());
        c.jira.mode = Some(JiraMode::Cloud);
        save(&p, &c).unwrap();
        assert_eq!(load(&p), c);
    }

    #[test]
    fn connect_linear_stores_key_and_config_never_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        http.push(200, VIEWER);
        let v = connect_with(
            &cfg_path(&dir),
            &keys,
            &http,
            &input(ConnectKind::Linear, "", "", "  tok-SENTINEL "),
        )
        .unwrap();
        assert!(v.linear.connected);
        assert_eq!(v.linear.account.as_deref(), Some("Ada"));
        let raw = keys.raw(TrackerKind::Linear).unwrap();
        assert!(raw.contains("api.linear.app") && raw.contains("tok-SENTINEL"));
        let text = std::fs::read_to_string(cfg_path(&dir)).unwrap();
        assert!(!text.contains("tok-SENTINEL"));
        assert!(!format!("{v:?}").contains("tok-SENTINEL"));
    }

    #[test]
    fn connect_failure_stores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        http.push(401, "");
        let r = connect_with(
            &cfg_path(&dir),
            &keys,
            &http,
            &input(ConnectKind::Linear, "", "", "tok"),
        );
        assert_eq!(code(r), "tracker_auth");
        assert!(keys.is_empty());
        assert!(!cfg_path(&dir).exists());
    }

    #[test]
    fn connect_input_checks_come_before_any_request() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        let p = cfg_path(&dir);
        assert_eq!(
            code(connect_with(
                &p,
                &keys,
                &http,
                &input(ConnectKind::Linear, "", "", "  ")
            )),
            "empty_key"
        );
        let long = "x".repeat(TOKEN_MAX + 1);
        assert_eq!(
            code(connect_with(
                &p,
                &keys,
                &http,
                &input(ConnectKind::Linear, "", "", &long)
            )),
            "too_large"
        );
        assert_eq!(
            code(connect_with(
                &p,
                &keys,
                &http,
                &input(ConnectKind::JiraServer, "http://x", "", "t")
            )),
            "tracker_bad_url"
        );
        assert_eq!(
            code(connect_with(
                &p,
                &keys,
                &http,
                &input(ConnectKind::JiraCloud, "a.example.com", "a@x.io", "t")
            )),
            "tracker_bad_url"
        );
        assert!(http.requests().is_empty());
    }

    #[test]
    fn connect_jira_cloud_talks_only_to_the_site() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        http.push(200, MYSELF);
        let v = connect_with(
            &cfg_path(&dir),
            &keys,
            &http,
            &input(ConnectKind::JiraCloud, "acme", "a@x.io", "tok"),
        )
        .unwrap();
        assert!(v.jira.connected);
        assert_eq!(v.jira.mode, Some(JiraMode::Cloud));
        assert_eq!(v.jira.base.as_deref(), Some("https://acme.atlassian.net"));
        assert_eq!(v.jira.email.as_deref(), Some("a@x.io"));
        assert!(
            http.requests()
                .iter()
                .all(|r| r.url.starts_with("https://acme.atlassian.net/"))
        );
        assert!(
            keys.raw(TrackerKind::Jira)
                .unwrap()
                .contains("acme.atlassian.net")
        );
    }

    #[test]
    fn keychain_failure_after_a_good_call_stores_no_config() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        keys.set_fail(true);
        http.push(200, VIEWER);
        let r = connect_with(
            &cfg_path(&dir),
            &keys,
            &http,
            &input(ConnectKind::Linear, "", "", "tok"),
        );
        assert_eq!(code(r), "secret_store");
        assert!(!cfg_path(&dir).exists());
    }

    #[test]
    fn list_refuses_a_key_for_another_host() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        let p = cfg_path(&dir);
        http.push(200, MYSELF);
        connect_with(
            &p,
            &keys,
            &http,
            &input(ConnectKind::JiraCloud, "acme", "a@x.io", "tok"),
        )
        .unwrap();
        let before = http.requests().len();
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, text.replace("acme.atlassian.net", "evil.example.com")).unwrap();
        assert_eq!(
            code(list_with(&p, &keys, &http, NOW, TrackerKind::Jira)),
            "tracker_not_configured"
        );
        assert_eq!(http.requests().len(), before);
        assert_eq!(
            code(list_with(&p, &keys, &http, NOW, TrackerKind::Linear)),
            "tracker_not_configured"
        );
    }

    #[test]
    fn linear_list_sends_since_thirty_days_back() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        let p = cfg_path(&dir);
        http.push(200, VIEWER);
        connect_with(&p, &keys, &http, &input(ConnectKind::Linear, "", "", "tok")).unwrap();
        pulls_set_with(
            &p,
            &keys,
            TaskSource::Linear,
            TrackerPulls {
                assigned: true,
                created: false,
                done: true,
            },
        )
        .unwrap();
        http.push(200, ISSUES);
        let list = list_with(&p, &keys, &http, NOW, TrackerKind::Linear).unwrap();
        assert_eq!(list.items.len(), 2);
        let req = http.requests().pop().unwrap();
        let want = since(NOW);
        assert!(want.starts_with("20"), "{want}");
        assert!(req.json.unwrap().contains(&want));
    }

    #[test]
    fn pulls_never_end_with_both_who_boxes_off() {
        let dir = tempfile::tempdir().unwrap();
        let v = pulls_set_with(
            &cfg_path(&dir),
            &MemoryKeys::new(),
            TaskSource::Github,
            TrackerPulls {
                assigned: false,
                created: false,
                done: false,
            },
        )
        .unwrap();
        assert_eq!(
            v.github,
            TrackerPulls {
                assigned: true,
                created: false,
                done: false
            }
        );
    }

    #[test]
    fn disconnect_removes_key_and_connection_keeps_pulls() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        let p = cfg_path(&dir);
        http.push(200, MYSELF);
        connect_with(
            &p,
            &keys,
            &http,
            &input(ConnectKind::JiraCloud, "acme", "a@x.io", "tok"),
        )
        .unwrap();
        let set = TrackerPulls {
            assigned: true,
            created: true,
            done: true,
        };
        pulls_set_with(&p, &keys, TaskSource::Jira, set).unwrap();
        let v = disconnect_with(&p, &keys, TrackerKind::Jira).unwrap();
        assert!(!v.jira.connected);
        assert!(keys.is_empty());
        assert_eq!(v.jira.pulls, set);
        let c = load(&p);
        assert_eq!(
            (c.jira.base, c.jira.email, c.jira.mode, c.jira.account),
            (None, None, None, None)
        );
    }

    #[test]
    fn list_errors_carry_no_detail_beyond_digits() {
        let dir = tempfile::tempdir().unwrap();
        let (keys, http) = (MemoryKeys::new(), FakeHttp::new());
        let p = cfg_path(&dir);
        http.push(200, VIEWER);
        connect_with(
            &p,
            &keys,
            &http,
            &input(ConnectKind::Linear, "", "", "tok-SENTINEL"),
        )
        .unwrap();
        let replies: [(u16, Option<u64>, &str); 7] = [
            (401, None, ""),
            (429, Some(60), ""),
            (500, None, "tok-SENTINEL"),
            (302, None, ""),
            (404, None, ""),
            (200, None, "not json tok-SENTINEL"),
            (200, None, r#"{"errors":[{"message":"tok-SENTINEL"}]}"#),
        ];
        for (status, retry, body) in replies {
            http.push_full(status, retry, body.as_bytes().to_vec());
            let e = list_with(&p, &keys, &http, NOW, TrackerKind::Linear).unwrap_err();
            if let Some(d) = e.detail {
                assert!(d.chars().all(|c| c.is_ascii_digit()), "{d}");
            }
        }
        http.push_offline();
        let e = list_with(&p, &keys, &http, NOW, TrackerKind::Linear).unwrap_err();
        assert_eq!((e.code, e.detail), ("tracker_offline", None));
        let e = {
            http.push_retry(429, 60, "");
            list_with(&p, &keys, &http, NOW, TrackerKind::Linear).unwrap_err()
        };
        assert_eq!(
            (e.code, e.detail.as_deref()),
            ("tracker_rate_limited", Some("60"))
        );
    }
}
