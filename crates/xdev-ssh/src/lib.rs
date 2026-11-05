//! Saved SSH hosts: the host model and its checks, a parser for the Host
//! blocks of an OpenSSH client config, and a small JSON store.

mod config;
mod store;

use serde::{Deserialize, Serialize};

pub use config::{ParsedConfig, parse_config};
pub use store::{SyncCounts, load, merge_config, remove, remove_many, save, upsert};

/// The file name in the app's config dir.
pub const STORE_FILE: &str = "ssh_hosts.json";

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SshError {
    #[error("alias")]
    Alias,
    #[error("host_name")]
    HostName,
    #[error("port")]
    Port,
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
    !alias.is_empty()
        && !alias.starts_with('-')
        && !alias.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// `host` with its text fields trimmed, or the first thing wrong with it.
/// An empty host name becomes the alias; an empty user or identity file is
/// none; port 0 is refused.
pub fn validate(host: &SshHost) -> Result<SshHost, SshError> {
    let alias = host.alias.trim();
    if !valid_alias(alias) {
        return Err(SshError::Alias);
    }
    let host_name = host.host_name.trim();
    if host_name
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
    {
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
    })
}

#[cfg(test)]
pub(crate) fn host(alias: &str) -> SshHost {
    SshHost {
        id: format!("id-{alias}"),
        alias: alias.to_owned(),
        host_name: format!("{alias}.example.com"),
        user: None,
        port: None,
        identity_file: None,
        source: HostSource::Manual,
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
}
