//! The values the peers UI sees (plan §3). The desktop glue fills them; the
//! `ts` feature writes their TypeScript into `packages/bindings`.

use serde::{Deserialize, Serialize};

/// What this computer lets a paired computer do. Ordered: a role allows
/// everything a lower one does.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PeerRole {
    #[default]
    None,
    Viewer,
    Operator,
    Admin,
}

impl PeerRole {
    /// `true` when this role is `min` or above.
    pub fn allows(self, min: PeerRole) -> bool {
        self >= min
    }

    /// Lane M's phone scope: `read` is Viewer, `control` is Operator.
    pub fn from_scope(scope: &str) -> PeerRole {
        match scope {
            "read" => PeerRole::Viewer,
            "control" => PeerRole::Operator,
            _ => PeerRole::None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PeerKind {
    #[default]
    Desktop,
    Phone,
}

/// Where the listener binds (M-R4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LinkBind {
    #[default]
    Localhost,
    Lan,
    Tailscale,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeersState {
    pub enabled: bool,
    pub bind: LinkBind,
    pub port: Option<u16>,
    pub host_id: String,
    pub host_name: String,
    pub fingerprint: String,
    pub pairing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub id: String,
    pub name: String,
    pub kind: PeerKind,
    /// What this computer lets the peer do.
    pub role: PeerRole,
    /// What the peer lets this computer do, from its `hello`.
    pub their_role: Option<PeerRole>,
    pub online: bool,
    pub last_seen_ms: Option<u64>,
    /// The peer's `hello` carried the same hashed xDev ID as this computer.
    #[serde(default)]
    pub same_xdev_id: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NearbyHost {
    pub host_id: String,
    /// Announced only while that computer's pair dialog is open.
    pub name: Option<String>,
    pub pairing: bool,
    pub paired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PairOfferView {
    /// `XXXXX-XXXXX`.
    pub code: String,
    /// `xdev://pair?d=…`.
    pub link: String,
    pub expires_at_ms: u64,
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JoinTarget {
    Nearby { host_id: String },
    Link { link: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PairPending {
    pub request_id: String,
    /// `482 913`.
    pub sas: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerProject {
    pub id: String,
    pub name: String,
    /// Only for Admin.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum PeerTermState {
    Running,
    Idle,
    NeedsInput,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerTerm {
    pub id: String,
    pub title: String,
    pub agent: Option<String>,
    pub state: PeerTermState,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerTermAttached {
    pub cols: u16,
    pub rows: u16,
}

/// `peers://pair-request` (host side).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerPairRequest {
    pub request_id: String,
    pub name: String,
    pub kind: PeerKind,
    pub sas: String,
}

/// `peers://pair-result`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerPairResult {
    pub ok: bool,
    pub name: Option<String>,
    /// An error code (`pair_code`, `pair_rejected`, …) when `ok` is false.
    pub error: Option<String>,
}

/// `peers://activity`: a toast on the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerActivity {
    /// The peer's name.
    pub peer: String,
    /// `typed`, `started` or `killed`.
    pub action: String,
    pub target: String,
}

/// `peers://confirm`: an action waiting for a click on the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerConfirm {
    pub request_id: String,
    pub peer: String,
    pub action: String,
    pub target: String,
}

/// `peers://term-closed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PeerTermClosed {
    pub peer_id: String,
    pub term_id: String,
    /// `exited`, `killed`, `offline` or `detached`.
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn role_order() {
        use PeerRole::*;
        assert!(Admin.allows(Operator));
        assert!(Operator.allows(Viewer));
        assert!(Viewer.allows(Viewer));
        assert!(!Viewer.allows(Operator));
        assert!(!None.allows(Viewer));
        assert!(None.allows(None));
        assert_eq!(PeerRole::from_scope("read"), Viewer);
        assert_eq!(PeerRole::from_scope("control"), Operator);
    }

    #[test]
    fn json_shapes() {
        assert_eq!(
            serde_json::to_value(JoinTarget::Nearby {
                host_id: "h".into()
            })
            .unwrap(),
            json!({"kind":"nearby","hostId":"h"})
        );
        assert_eq!(
            serde_json::to_value(JoinTarget::Link { link: "l".into() }).unwrap(),
            json!({"kind":"link","link":"l"})
        );
        assert_eq!(
            serde_json::to_value(PeerTermState::NeedsInput).unwrap(),
            json!("needs_input")
        );
        assert_eq!(
            serde_json::to_value(PeerRole::Viewer).unwrap(),
            json!("viewer")
        );
        assert_eq!(
            serde_json::to_value(LinkBind::Tailscale).unwrap(),
            json!("tailscale")
        );
    }
}
