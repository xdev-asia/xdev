//! Local ports for the desktop app: which processes listen on this machine,
//! which worktree each belongs to, and the URLs a terminal printed for them.
//! Everything here reads local tables only; nothing touches the network.

pub mod attribute;
pub mod parse;
mod probe;
pub mod urls;

pub use probe::{Listener, OsProbe, Probe, Proc, PtyRoot, ScanError};

use serde::{Deserialize, Serialize};

/// Whose port it is. `Workspace` ports belong to a worktree the app knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PortKind {
    Workspace,
    Container,
    External,
}

/// What the port most likely speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PortProtocol {
    Http,
    Https,
    Unknown,
}

/// Why a port was tied to a worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PortEvidence {
    /// The listener runs under a terminal the app started in that worktree.
    Terminal,
    /// The listener's working folder is inside the worktree.
    Cwd,
    /// The worktree path appears in the listener's command line.
    Command,
}

/// One listening TCP port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePort {
    /// `{connectHost}:{port}:{pid|unknown}`.
    pub id: String,
    pub bind_host: String,
    pub connect_host: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub protocol: PortProtocol,
    pub kind: PortKind,
    /// The worktree path, for a `Workspace` port.
    pub worktree: Option<String>,
    pub evidence: Option<PortEvidence>,
    /// The origin a terminal printed, else `{protocol|http}://{host}:{port}`.
    pub url: String,
    /// Whether `url` was printed by a terminal rather than guessed.
    pub advertised: bool,
}

/// The result of one scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PortScan {
    /// `windows`, `macos` or `linux`.
    pub platform: String,
    /// Milliseconds since the epoch.
    pub scanned_at: u64,
    pub ports: Vec<WorkspacePort>,
    /// Why there is no fresh list: `scan_timeout`, `scan_failed` or `unsupported`.
    pub unavailable: Option<String>,
    pub detail: Option<String>,
    /// Seconds until the next try, with `scan_timeout`.
    pub retry_in: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> WorkspacePort {
        WorkspacePort {
            id: "localhost:5173:42".into(),
            bind_host: "::".into(),
            connect_host: "localhost".into(),
            port: 5173,
            pid: Some(42),
            process_name: Some("node".into()),
            protocol: PortProtocol::Http,
            kind: PortKind::Workspace,
            worktree: Some("/w/a".into()),
            evidence: Some(PortEvidence::Terminal),
            url: "http://localhost:5173".into(),
            advertised: true,
        }
    }

    #[test]
    fn a_port_is_camel_case_with_lowercase_enums() {
        let json = serde_json::to_value(sample()).unwrap();
        assert_eq!(json["bindHost"], "::");
        assert_eq!(json["connectHost"], "localhost");
        assert_eq!(json["processName"], "node");
        assert_eq!(json["protocol"], "http");
        assert_eq!(json["kind"], "workspace");
        assert_eq!(json["evidence"], "terminal");
        let back: WorkspacePort = serde_json::from_value(json).unwrap();
        assert_eq!(back, sample());
    }

    #[test]
    fn a_scan_round_trips() {
        let scan = PortScan {
            platform: "windows".into(),
            scanned_at: 1_700_000_000_000,
            ports: vec![sample()],
            unavailable: Some("scan_timeout".into()),
            detail: None,
            retry_in: Some(60),
        };
        let json = serde_json::to_value(&scan).unwrap();
        assert_eq!(json["scannedAt"], 1_700_000_000_000u64);
        assert_eq!(json["retryIn"], 60);
        assert_eq!(serde_json::from_value::<PortScan>(json).unwrap(), scan);
    }
}
