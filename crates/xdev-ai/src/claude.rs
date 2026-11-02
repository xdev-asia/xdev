use std::env;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AiError;
use crate::accounts::AccountEntry;
use crate::quota::{QuotaWindow, Reason};

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const USAGE_TIMEOUT: Duration = Duration::from_secs(20);
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const LOCAL_PREFIX: &str = "http://127.0.0.1:";
/// Neither answer is ever near this; a cap keeps a broken peer from
/// filling memory.
const MAX_BODY: u64 = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusState {
    LoggedIn,
    LoggedOut,
    NoClaude,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub state: StatusState,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub org: Option<String>,
}

impl AccountStatus {
    fn bare(state: StatusState) -> Self {
        AccountStatus {
            state,
            email: None,
            plan: None,
            org: None,
        }
    }
}

/// `XDEV_CLAUDE_BIN`, else `claude` on `PATH`. On Windows that is
/// `claude.exe`, then npm's `claude.cmd`; npm's extensionless `claude` there
/// is a shell script Windows cannot start.
pub fn claude_command() -> Result<Command, AiError> {
    if let Some(bin) = env::var_os("XDEV_CLAUDE_BIN").filter(|b| !b.is_empty()) {
        let bin = PathBuf::from(bin);
        return if bin.is_file() {
            Ok(Command::new(bin))
        } else {
            Err(AiError::NoClaude)
        };
    }
    let path = env::var_os("PATH").unwrap_or_default();
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &["claude"]
    };
    names
        .iter()
        .find_map(|name| {
            env::split_paths(&path)
                .map(|dir| dir.join(name))
                .find(|p| p.is_file())
        })
        .map(Command::new)
        .ok_or(AiError::NoClaude)
}

/// Sign-in state from `claude auth status --json`. Never fails: a missing
/// `claude` is `no_claude`, anything else unexpected is `error`.
pub fn status(entry: &AccountEntry) -> AccountStatus {
    let Ok(mut cmd) = claude_command() else {
        return AccountStatus::bare(StatusState::NoClaude);
    };
    cmd.args(["auth", "status", "--json"])
        .env("CLAUDE_CONFIG_DIR", &entry.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The desktop polls this; without the flag every poll flashes a console.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match stdout_within(cmd, STATUS_TIMEOUT) {
        Ok(out) => parse_status(&out),
        Err(e) if e.kind() == io::ErrorKind::NotFound => AccountStatus::bare(StatusState::NoClaude),
        Err(_) => AccountStatus::bare(StatusState::Error),
    }
}

fn stdout_within(mut cmd: Command, timeout: Duration) -> io::Result<Vec<u8>> {
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let (tx, rx) = mpsc::channel();
    // A reader thread, so a child that hangs, or leaves a grandchild holding
    // the pipe, cannot block past the timeout.
    thread::spawn(move || {
        let mut buf = Vec::new();
        let read = stdout.take(MAX_BODY).read_to_end(&mut buf).map(|_| buf);
        let _ = tx.send(read);
    });
    match rx.recv_timeout(timeout) {
        Ok(read) => {
            let _ = child.wait();
            read
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(io::ErrorKind::TimedOut.into())
        }
    }
}

fn parse_status(out: &[u8]) -> AccountStatus {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        logged_in: bool,
        email: Option<String>,
        subscription_type: Option<String>,
        org_name: Option<String>,
    }
    // The exit code is not trusted: a signed-out account may exit non-zero
    // with valid JSON.
    match serde_json::from_slice::<Raw>(out) {
        Ok(raw) => AccountStatus {
            state: if raw.logged_in {
                StatusState::LoggedIn
            } else {
                StatusState::LoggedOut
            },
            email: raw.email,
            plan: raw.subscription_type,
            org: raw.org_name,
        },
        Err(_) => AccountStatus::bare(StatusState::Error),
    }
}

/// The command that signs an account in, in the platform shell's own syntax.
pub fn login_command(dir: &Path, windows: bool) -> String {
    let dir = dir.to_string_lossy();
    if windows {
        format!(
            "$env:CLAUDE_CONFIG_DIR='{}'; claude auth login",
            dir.replace('\'', "''")
        )
    } else {
        format!(
            "CLAUDE_CONFIG_DIR='{}' claude auth login",
            dir.replace('\'', r"'\''")
        )
    }
}

/// An OAuth access token. Neither `Debug` nor `Display` can show it, so it
/// cannot leak through a log line or an error.
struct Token(String);

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// The account's quota windows. The only caller of the usage endpoint,
/// which is undocumented and may change.
pub(crate) fn usage(dir: &Path) -> Result<Vec<QuotaWindow>, Reason> {
    let token = read_token(dir)?;
    fetch_usage(&token)
}

fn read_token(dir: &Path) -> Result<Token, Reason> {
    let text =
        fs::read_to_string(dir.join(".credentials.json")).map_err(|_| Reason::NoCredentials)?;
    // Parse errors are dropped, not shown: their text may quote the file.
    let mut json: Value = serde_json::from_str(&text).map_err(|_| Reason::NoCredentials)?;
    let oauth = json.get_mut("claudeAiOauth").ok_or(Reason::NoCredentials)?;
    let expires_at = oauth.get("expiresAt").and_then(Value::as_f64);
    let token = match oauth.get_mut("accessToken").map(Value::take) {
        Some(Value::String(token)) if !token.is_empty() => Token(token),
        _ => return Err(Reason::NoCredentials),
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64);
    // Refreshing is Claude Code's job; an expired token is not sent at all.
    if expires_at.is_some_and(|at| at <= now_ms) {
        return Err(Reason::Expired);
    }
    Ok(token)
}

fn fetch_usage(token: &Token) -> Result<Vec<QuotaWindow>, Reason> {
    let url = usage_url(env::var("XDEV_CLAUDE_USAGE_URL").ok());
    let mut config = ureq::Agent::config_builder()
        .timeout_global(Some(USAGE_TIMEOUT))
        // A redirect could carry the request somewhere else.
        .max_redirects(0)
        .http_status_as_error(false);
    if url.starts_with(LOCAL_PREFIX) {
        // Plain HTTP through a proxy would show the token to the proxy.
        config = config.proxy(None);
    }
    let agent: ureq::Agent = config.build().into();
    let mut response = agent
        .get(&url)
        .header("Authorization", format!("Bearer {}", token.0))
        .header("anthropic-beta", "oauth-2025-04-20")
        .call()
        .map_err(|_| Reason::Unavailable)?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(Reason::Expired),
        _ => return Err(Reason::Unavailable),
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(|_| Reason::Unavailable)?;
    parse_usage(&body).ok_or(Reason::Unavailable)
}

/// The test override, only when it names a port on 127.0.0.1, so a set
/// variable can never send the token to another host (`http://127.0.0.1:@evil`
/// would).
fn usage_url(env: Option<String>) -> String {
    if let Some(url) = env
        && let Some(rest) = url.strip_prefix(LOCAL_PREFIX)
    {
        let port = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if port > 0 && matches!(rest[port..].chars().next(), None | Some('/')) {
            return url;
        }
    }
    USAGE_URL.to_owned()
}

/// Every top-level object with a `utilization` key is a window, so new
/// windows show up without a code change.
fn parse_usage(body: &str) -> Option<Vec<QuotaWindow>> {
    let Value::Object(map) = serde_json::from_str(body).ok()? else {
        return None;
    };
    let mut windows: Vec<QuotaWindow> = map
        .into_iter()
        .filter_map(|(key, value)| {
            let window = value.as_object()?;
            if !window.contains_key("utilization") {
                return None;
            }
            Some(QuotaWindow {
                utilization: window.get("utilization").and_then(Value::as_f64),
                resets_at: window
                    .get("resets_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                key,
            })
        })
        .collect();
    let rank = |key: &str| match key {
        "five_hour" => 0,
        "seven_day" => 1,
        _ => 2,
    };
    windows.sort_by(|a, b| {
        rank(&a.key)
            .cmp(&rank(&b.key))
            .then_with(|| a.key.cmp(&b.key))
    });
    Some(windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_debug_is_redacted() {
        let token = Token("sk-ant-secret".into());
        assert_eq!(format!("{token:?}"), "<redacted>");
        let wrapped = Some(token);
        assert!(!format!("{wrapped:?}").contains("secret"));
    }

    #[test]
    fn usage_url_override_is_local_only() {
        let local = "http://127.0.0.1:4321/api/oauth/usage";
        assert_eq!(usage_url(Some(local.into())), local);
        assert_eq!(
            usage_url(Some("http://127.0.0.1:4321".into())),
            "http://127.0.0.1:4321"
        );
        for bad in [
            "http://127.0.0.1:@evil.example/",
            "http://127.0.0.1:80@evil.example/",
            "http://127.0.0.1:80\\@evil.example/",
            "http://127.0.0.1:80?@evil.example/",
            "http://127.0.0.1.evil.example:80/",
            "http://localhost:80/",
            "https://evil.example/",
            "",
        ] {
            assert_eq!(usage_url(Some(bad.into())), USAGE_URL, "{bad}");
        }
        assert_eq!(usage_url(None), USAGE_URL);
    }

    #[test]
    fn usage_skips_non_windows() {
        assert_eq!(parse_usage("[]"), None);
        assert_eq!(parse_usage(r#"{"x": null, "y": {"a": 1}}"#), Some(vec![]));
    }
}
