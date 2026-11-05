//! Saved SSH hosts: the host model and its checks, a parser for the Host
//! blocks of an OpenSSH client config, a small JSON store, the `ssh` argv
//! of a host, and the pure parts of testing and keeping a connection.

mod argv;
mod config;
mod connection;
mod store;

use serde::{Deserialize, Serialize};

pub use argv::{
    CONNECT_TIMEOUT_DEFAULT, connect_argv, effective_timeout, forward_spec, ssh_argv, test_argv,
};
pub use config::{ParsedConfig, parse_config};
pub use connection::{
    Connection, SETTLE, SshConnState, SshPromptKind, SshTestOutcome, classify, prompt_kind,
};
pub use store::{SyncCounts, load, merge_config, remove, remove_many, save, upsert};

/// The file name in the app's config dir.
pub const STORE_FILE: &str = "ssh_hosts.json";

/// The shortest and longest `ConnectTimeout` a host keeps, in seconds.
pub const TIMEOUT_MIN: u16 = 1;
pub const TIMEOUT_MAX: u16 = 120;

/// Where a host came from. A `SshConfig` host is refreshed by a sync; a
/// `Manual` one never is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum HostSource {
    #[default]
    Manual,
    SshConfig,
}

/// `-L local_port:remote_host:remote_port`: a port on this machine that the
/// server connects on to `remote_host:remote_port`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalForward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    /// Empty in a save asks for a new one.
    pub id: String,
    /// What `ssh` is given: no whitespace, unique among the hosts.
    pub alias: String,
    /// The address; the alias itself when the config has no `HostName`.
    pub host_name: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub user: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub port: Option<u16>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub source: HostSource,
    /// `-J`: one jump host or a comma list of them.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub proxy_jump: Option<String>,
    /// `-A`.
    #[serde(default)]
    pub forward_agent: bool,
    #[serde(default)]
    pub local_forwards: Vec<LocalForward>,
    /// `-o ConnectTimeout=`, kept within `TIMEOUT_MIN..=TIMEOUT_MAX`.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub connect_timeout_secs: Option<u16>,
    /// More `-o` options, each `Key=Value`.
    #[serde(default)]
    pub extra_options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SshError {
    #[error("alias")]
    Alias,
    #[error("host_name")]
    HostName,
    #[error("port")]
    Port,
    #[error("proxy_jump")]
    ProxyJump,
    #[error("local_forward")]
    LocalForward,
    #[error("extra_option")]
    ExtraOption,
    #[error("duplicate_alias")]
    DuplicateAlias,
    #[error("not_found")]
    NotFound,
    #[error("io: {0}")]
    Io(String),
}

impl SshError {
    /// A stable word the UI can translate.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Alias => "alias",
            Self::HostName => "host_name",
            Self::Port => "port",
            Self::ProxyJump => "proxy_jump",
            Self::LocalForward => "local_forward",
            Self::ExtraOption => "extra_option",
            Self::DuplicateAlias => "duplicate_alias",
            Self::NotFound => "not_found",
            Self::Io(_) => "io",
        }
    }
}

impl From<std::io::Error> for SshError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

/// An alias `ssh` takes as a host: not empty, no whitespace, no control
/// characters, and not starting with `-` (it would be read as an option).
pub fn valid_alias(alias: &str) -> bool {
    !alias.is_empty() && plain_word(alias)
}

/// A word `ssh` takes as a value: no whitespace, no control characters, not
/// starting with `-`.
fn plain_word(word: &str) -> bool {
    !word.starts_with('-') && !word.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// An extra option `Key=Value`: a key of letters and digits starting with a
/// letter, a value that is not blank and has no control characters.
pub fn valid_extra_option(option: &str) -> bool {
    let Some((key, value)) = option.split_once('=') else {
        return false;
    };
    key.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && key.chars().all(|c| c.is_ascii_alphanumeric())
        && !value.trim().is_empty()
        && !value.chars().any(char::is_control)
}

fn valid_forward(f: &LocalForward) -> bool {
    f.local_port != 0
        && f.remote_port != 0
        && !f.remote_host.is_empty()
        && plain_word(&f.remote_host)
}

/// `host` with its text fields trimmed, or the first thing wrong with it.
/// An empty host name becomes the alias; an empty user, identity file or
/// jump host is none; port 0 is refused; the connect timeout is clamped to
/// `TIMEOUT_MIN..=TIMEOUT_MAX`; blank extra options are dropped.
pub fn validate(host: &SshHost) -> Result<SshHost, SshError> {
    let alias = host.alias.trim();
    if !valid_alias(alias) {
        return Err(SshError::Alias);
    }
    let host_name = host.host_name.trim();
    if !plain_word(host_name) {
        return Err(SshError::HostName);
    }
    if host.port == Some(0) {
        return Err(SshError::Port);
    }
    let text = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let proxy_jump = text(&host.proxy_jump);
    if proxy_jump.as_deref().is_some_and(|j| !plain_word(j)) {
        return Err(SshError::ProxyJump);
    }
    let local_forwards: Vec<LocalForward> = host
        .local_forwards
        .iter()
        .map(|f| LocalForward {
            remote_host: f.remote_host.trim().to_owned(),
            ..f.clone()
        })
        .collect();
    if !local_forwards.iter().all(valid_forward) {
        return Err(SshError::LocalForward);
    }
    let extra_options: Vec<String> = host
        .extra_options
        .iter()
        .map(|o| o.trim().to_owned())
        .filter(|o| !o.is_empty())
        .collect();
    if !extra_options.iter().all(|o| valid_extra_option(o)) {
        return Err(SshError::ExtraOption);
    }
    Ok(SshHost {
        id: host.id.clone(),
        alias: alias.to_owned(),
        host_name: if host_name.is_empty() {
            alias
        } else {
            host_name
        }
        .to_owned(),
        user: text(&host.user),
        port: host.port,
        identity_file: text(&host.identity_file),
        source: host.source,
        proxy_jump,
        forward_agent: host.forward_agent,
        local_forwards,
        connect_timeout_secs: host
            .connect_timeout_secs
            .map(|t| t.clamp(TIMEOUT_MIN, TIMEOUT_MAX)),
        extra_options,
    })
}

#[cfg(test)]
pub(crate) fn host(alias: &str) -> SshHost {
    SshHost {
        id: format!("id-{alias}"),
        alias: alias.to_owned(),
        host_name: format!("{alias}.example.com"),
        ..SshHost::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_rules() {
        assert!(valid_alias("web-1"));
        assert!(!valid_alias(""));
        assert!(!valid_alias("a b"));
        assert!(!valid_alias("a\tb"));
        assert!(!valid_alias("-oProxyCommand=x"));
    }

    #[test]
    fn validate_checks_alias_and_port() {
        let mut h = host("web");
        assert!(validate(&h).is_ok());
        h.alias = "  ".into();
        assert_eq!(validate(&h), Err(SshError::Alias));
        h.alias = "a b".into();
        assert_eq!(validate(&h), Err(SshError::Alias));
        h.alias = "web".into();
        h.port = Some(0);
        assert_eq!(validate(&h), Err(SshError::Port));
        h.port = Some(1);
        assert!(validate(&h).is_ok());
        h.port = Some(65535);
        assert!(validate(&h).is_ok());
    }

    #[test]
    fn validate_trims_and_defaults() {
        let mut h = host("web");
        h.alias = " web ".into();
        h.host_name = "  ".into();
        h.user = Some("  ".into());
        h.identity_file = Some(" ~/.ssh/id ".into());
        let v = validate(&h).unwrap();
        assert_eq!(v.alias, "web");
        assert_eq!(v.host_name, "web");
        assert_eq!(v.user, None);
        assert_eq!(v.identity_file.as_deref(), Some("~/.ssh/id"));
        h.host_name = "a b".into();
        assert_eq!(validate(&h), Err(SshError::HostName));
    }

    #[test]
    fn host_name_may_not_be_an_option() {
        let mut h = host("web");
        h.host_name = "-oProxyCommand=x".into();
        assert_eq!(validate(&h), Err(SshError::HostName));
    }

    #[test]
    fn validate_proxy_jump() {
        let mut h = host("web");
        h.proxy_jump = Some(" bastion,user@jump:2222 ".into());
        assert_eq!(
            validate(&h).unwrap().proxy_jump.as_deref(),
            Some("bastion,user@jump:2222")
        );
        h.proxy_jump = Some("  ".into());
        assert_eq!(validate(&h).unwrap().proxy_jump, None);
        for bad in ["-oProxyCommand=x", "a b"] {
            h.proxy_jump = Some(bad.into());
            assert_eq!(validate(&h), Err(SshError::ProxyJump), "{bad:?}");
        }
    }

    #[test]
    fn validate_connect_timeout_is_clamped() {
        let mut h = host("web");
        for (given, kept) in [
            (0, TIMEOUT_MIN),
            (30, 30),
            (121, TIMEOUT_MAX),
            (500, TIMEOUT_MAX),
        ] {
            h.connect_timeout_secs = Some(given);
            assert_eq!(validate(&h).unwrap().connect_timeout_secs, Some(kept));
        }
        h.connect_timeout_secs = None;
        assert_eq!(validate(&h).unwrap().connect_timeout_secs, None);
    }

    #[test]
    fn validate_local_forwards() {
        let mut h = host("web");
        let fwd = |l: u16, host: &str, r: u16| LocalForward {
            local_port: l,
            remote_host: host.into(),
            remote_port: r,
        };
        h.local_forwards = vec![fwd(8080, " localhost ", 80)];
        assert_eq!(
            validate(&h).unwrap().local_forwards[0].remote_host,
            "localhost"
        );
        for bad in [
            fwd(0, "h", 80),
            fwd(8080, "", 80),
            fwd(8080, "h", 0),
            fwd(8080, "a b", 80),
            fwd(8080, "-x", 80),
        ] {
            h.local_forwards = vec![bad.clone()];
            assert_eq!(validate(&h), Err(SshError::LocalForward), "{bad:?}");
        }
    }

    #[test]
    fn validate_extra_options() {
        let mut h = host("web");
        h.extra_options = vec![" ServerAliveInterval=30 ".into(), "  ".into()];
        assert_eq!(
            validate(&h).unwrap().extra_options,
            ["ServerAliveInterval=30"]
        );
        h.extra_options = vec!["SetEnv=A=b c".into()];
        assert!(validate(&h).is_ok());
        for bad in [
            "NoEquals", "=v", "Key=", "Key= ", "Ke y=v", "1Key=v", "Key=a\nb",
        ] {
            h.extra_options = vec![bad.into()];
            assert_eq!(validate(&h), Err(SshError::ExtraOption), "{bad:?}");
        }
    }

    #[test]
    fn forward_agent_is_kept() {
        let mut h = host("web");
        h.forward_agent = true;
        assert!(validate(&h).unwrap().forward_agent);
    }

    #[test]
    fn an_old_host_loads_with_the_new_fields_empty() {
        let old =
            r#"{"id":"a","alias":"web","hostName":"w","user":"u","port":22,"source":"manual"}"#;
        let h: SshHost = serde_json::from_str(old).unwrap();
        assert_eq!(h.alias, "web");
        assert_eq!(h.user.as_deref(), Some("u"));
        assert_eq!(h.proxy_jump, None);
        assert!(!h.forward_agent);
        assert!(h.local_forwards.is_empty());
        assert_eq!(h.connect_timeout_secs, None);
        assert!(h.extra_options.is_empty());
    }
}
