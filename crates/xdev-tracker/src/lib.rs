//! Read-only Linear and Jira clients, their types, transport and key store.
//!
//! No Tauri here: the desktop crate wires these to commands. Tests use `FakeHttp` and
//! `MemoryKeys`, never the network or the OS keychain.

use serde::{Deserialize, Serialize};

pub mod http;
pub mod jira;
pub mod keys;
pub mod linear;
pub mod ureq_http;
pub mod urls;

pub const ITEMS_MAX: usize = 200;
pub const PAGE_SIZE: u32 = 50;
pub const PAGES_MAX: usize = 4;
pub const BODY_MAX: usize = 2 * 1024 * 1024;
pub const TOKEN_MAX: usize = 1200;
pub const LINEAR_ENDPOINT: &str = "https://api.linear.app/graphql";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TaskSource {
    Github,
    Linear,
    Jira,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TrackerKind {
    Linear,
    Jira,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum JiraMode {
    Cloud,
    Server,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TrackerStateKind {
    Todo,
    InProgress,
    Done,
    Canceled,
}

/// The checklist of what a source pulls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct TrackerPulls {
    pub assigned: bool,
    pub created: bool,
    pub done: bool,
}

impl Default for TrackerPulls {
    fn default() -> Self {
        Self {
            assigned: true,
            created: false,
            done: false,
        }
    }
}

impl TrackerPulls {
    /// At least one of assigned / created stays on.
    pub fn normalized(mut self) -> Self {
        if !self.assigned && !self.created {
            self.assigned = true;
        }
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TrackerItem {
    pub source: TaskSource,
    pub id: String,
    pub key: String,
    pub title: String,
    pub state: String,
    pub state_kind: TrackerStateKind,
    pub assignee: Option<String>,
    pub url: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TrackerList {
    pub items: Vec<TrackerItem>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackerError {
    NotConfigured,
    BadUrl,
    Auth,
    RateLimited(Option<u64>),
    Offline,
    Redirected,
    NotFound,
    Unavailable,
    BadReply,
    SecretStore,
    EmptyKey,
    TooLarge,
}

impl TrackerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "tracker_not_configured",
            Self::BadUrl => "tracker_bad_url",
            Self::Auth => "tracker_auth",
            Self::RateLimited(_) => "tracker_rate_limited",
            Self::Offline => "tracker_offline",
            Self::Redirected => "tracker_redirected",
            Self::NotFound => "tracker_not_found",
            Self::Unavailable => "tracker_unavailable",
            Self::BadReply => "tracker_bad_reply",
            Self::SecretStore => "secret_store",
            Self::EmptyKey => "empty_key",
            Self::TooLarge => "too_large",
        }
    }

    /// Only the retry seconds; never a URL, token or body.
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::RateLimited(Some(secs)) => Some(secs.to_string()),
            _ => None,
        }
    }
}

impl std::fmt::Display for TrackerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for TrackerError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_serializes_camel_case() {
        let item = TrackerItem {
            source: TaskSource::Linear,
            id: "i1".into(),
            key: "ENG-12".into(),
            title: "Fix".into(),
            state: "In Progress".into(),
            state_kind: TrackerStateKind::InProgress,
            assignee: None,
            url: "https://linear.app/x/issue/ENG-12".into(),
            updated_at: "2026-11-05T10:00:00Z".into(),
        };
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["source"], "linear");
        assert_eq!(v["key"], "ENG-12");
        assert_eq!(v["stateKind"], "inProgress");
        assert_eq!(v["updatedAt"], "2026-11-05T10:00:00Z");
        assert!(v["assignee"].is_null());
    }

    #[test]
    fn pulls_default_and_normalized() {
        let d = TrackerPulls::default();
        assert_eq!((d.assigned, d.created, d.done), (true, false, false));
        let off = TrackerPulls {
            assigned: false,
            created: false,
            done: true,
        };
        let n = off.normalized();
        assert!(n.assigned && !n.created && n.done);
        let only_created = TrackerPulls {
            assigned: false,
            created: true,
            done: false,
        };
        assert_eq!(only_created.normalized(), only_created);
    }

    #[test]
    fn error_codes_are_distinct_and_namespaced() {
        let all = [
            TrackerError::NotConfigured,
            TrackerError::BadUrl,
            TrackerError::Auth,
            TrackerError::RateLimited(None),
            TrackerError::Offline,
            TrackerError::Redirected,
            TrackerError::NotFound,
            TrackerError::Unavailable,
            TrackerError::BadReply,
            TrackerError::SecretStore,
            TrackerError::EmptyKey,
            TrackerError::TooLarge,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for e in &all {
            assert!(seen.insert(e.code()));
            let shared = ["secret_store", "empty_key", "too_large"];
            assert!(e.code().starts_with("tracker_") || shared.contains(&e.code()));
        }
        assert_eq!(
            TrackerError::RateLimited(Some(30)).detail().as_deref(),
            Some("30")
        );
        assert_eq!(TrackerError::RateLimited(None).detail(), None);
        assert_eq!(TrackerError::Auth.detail(), None);
    }
}
