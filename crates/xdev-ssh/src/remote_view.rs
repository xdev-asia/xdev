//! The remote-project values that cross to the UI (`ts` feature).

use serde::{Deserialize, Serialize};

/// A folder on a saved host, shown as a project. Stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    pub host_id: String,
    /// Absolute, as `realpath` gave it.
    pub path: String,
    pub name: String,
    /// Run terminals and agents inside tmux when the host has it.
    pub keep_alive: bool,
    pub added_ms: u64,
}

/// A remote project with what the sidebar shows next to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectView {
    #[serde(flatten)]
    #[cfg_attr(feature = "ts", ts(flatten))]
    pub project: RemoteProject,
    pub host_alias: String,
    /// `ssh://<host id><path>`: what file and worktree calls take.
    pub worktree: String,
    pub state: RemoteConnState,
}

/// The connection of one host.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RemoteConnState {
    #[default]
    Idle,
    Connecting,
    Connected {
        tmux: bool,
        git: bool,
    },
    #[serde(rename_all = "camelCase")]
    Reconnecting {
        attempt: u32,
        next_in_secs: u32,
    },
    Offline {
        reason: String,
    },
}

/// The payload of `remote://state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostView {
    pub host_id: String,
    pub alias: String,
    pub conn: RemoteConnState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDir {
    pub name: String,
    /// Absolute.
    pub path: String,
}

/// The subfolders of one folder on a host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirListing {
    pub path: String,
    /// `None` at `/`.
    pub parent: Option<String>,
    pub dirs: Vec<RemoteDir>,
    /// More than `DIRS_MAX` folders; only the first are listed.
    pub truncated: bool,
}

/// Where "run on host" starts agents for a local project. Stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    pub host_id: String,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_view_is_flat() {
        let v = RemoteProjectView {
            project: RemoteProject {
                id: "r1".into(),
                host_id: "devbox".into(),
                path: "/home/dev/app".into(),
                name: "app".into(),
                keep_alive: true,
                added_ms: 5,
            },
            host_alias: "devbox".into(),
            worktree: "ssh://devbox/home/dev/app".into(),
            state: RemoteConnState::Connected {
                tmux: true,
                git: true,
            },
        };
        assert_eq!(
            serde_json::to_value(&v).unwrap(),
            serde_json::json!({
                "id": "r1", "hostId": "devbox", "path": "/home/dev/app", "name": "app",
                "keepAlive": true, "addedMs": 5, "hostAlias": "devbox",
                "worktree": "ssh://devbox/home/dev/app",
                "state": {"state": "connected", "tmux": true, "git": true}
            })
        );
    }

    #[test]
    fn listing_parent_is_null_at_root() {
        let l = RemoteDirListing {
            path: "/".into(),
            parent: None,
            dirs: vec![],
            truncated: false,
        };
        assert_eq!(
            serde_json::to_string(&l).unwrap(),
            r#"{"path":"/","parent":null,"dirs":[],"truncated":false}"#
        );
    }
}
