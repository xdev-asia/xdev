//! Where a terminal's process runs: in the app (`LocalHost`, as before the
//! service) or in the per-user `xdev-ptyd` service (`ServiceHost`), which
//! keeps it running when the app quits, updates or crashes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use xdev_pty::client::{Client, ClientError, Sink, StartOptions, ensure};
use xdev_pty::{Session, SpawnSpec};

use crate::commands::CmdError;
use crate::pty::{PtyHandle, PtydState, PtydStatus, Ptys};
use crate::settings::TerminalSettings;

impl From<ClientError> for CmdError {
    fn from(e: ClientError) -> CmdError {
        // `CmdError.code` is static: the service's codes are mapped to the
        // ones the UI knows, anything else reads as an unreachable service.
        let code = match e.code.as_str() {
            "pty_gone" => "pty_gone",
            "pty_exists" => "pty_exists",
            "pty_spawn" => "pty_spawn",
            "pty_resize" => "pty_resize",
            "bad_arg" => "bad_arg",
            "ptyd_auth" => "ptyd_auth",
            "ptyd_version" => "ptyd_version",
            "ptyd_start_failed" => "ptyd_start_failed",
            _ => "ptyd_unreachable",
        };
        CmdError {
            code,
            detail: e.detail,
        }
    }
}

pub(crate) trait PtyHost: Send + Sync {
    /// Starts `spec` as `id`; `meta` is what the service lists it with.
    fn spawn(
        &self,
        id: &str,
        spec: SpawnSpec,
        meta: serde_json::Value,
        sink: Sink,
    ) -> Result<Box<dyn PtyHandle>, CmdError>;

    /// The service behind this host; none for `LocalHost`.
    #[allow(dead_code)] // The ptyd_* commands ask for it.
    fn service(&self) -> Option<Arc<Client>> {
        None
    }
}

/// Each PTY in this process; they end with it.
pub(crate) struct LocalHost;

impl PtyHost for LocalHost {
    fn spawn(
        &self,
        _id: &str,
        spec: SpawnSpec,
        _meta: serde_json::Value,
        sink: Sink,
    ) -> Result<Box<dyn PtyHandle>, CmdError> {
        let session = Session::spawn(spec, sink.on_output, sink.on_exit)?;
        Ok(Box::new(session))
    }
}

/// Each PTY in the service; they run on when the app ends.
pub(crate) struct ServiceHost {
    pub client: Arc<Client>,
}

impl PtyHost for ServiceHost {
    fn spawn(
        &self,
        id: &str,
        spec: SpawnSpec,
        meta: serde_json::Value,
        sink: Sink,
    ) -> Result<Box<dyn PtyHandle>, CmdError> {
        let pid = self.client.spawn(id, spec, meta, sink)?;
        Ok(Box::new(ServicePty {
            client: self.client.clone(),
            id: id.to_owned(),
            pid,
        }))
    }

    fn service(&self) -> Option<Arc<Client>> {
        Some(self.client.clone())
    }
}

/// A PTY in the service. Dropping it does not end it: only `kill` does.
pub(crate) struct ServicePty {
    pub client: Arc<Client>,
    pub id: String,
    pub pid: Option<u32>,
}

impl PtyHandle for ServicePty {
    fn write(&self, d: Vec<u8>) {
        self.client.write(&self.id, d);
    }

    fn resize(&self, c: u16, r: u16) -> Result<(), xdev_pty::PtyError> {
        self.client
            .resize(&self.id, c, r)
            .map_err(|e| xdev_pty::PtyError::Resize(e.to_string()))
    }

    fn ack(&self, n: usize) {
        self.client.ack(&self.id, n as u64);
    }

    fn kill(&self) {
        self.client.kill(&self.id);
    }

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}

/// The host for this app run. `start` runs only when the setting is on; a
/// failure falls back to the app (R3) with the reason in the status.
pub(crate) fn choose_host(
    service: bool,
    app_version: &str,
    start: impl FnOnce() -> Result<Client, ClientError>,
) -> (Arc<dyn PtyHost>, PtydStatus) {
    if !service {
        return (Arc::new(LocalHost), status(PtydState::Off, None, None));
    }
    match start() {
        Ok(client) => {
            let version = client.welcome().service_version.clone();
            let state = if version == app_version {
                PtydState::Running
            } else {
                PtydState::OldVersion
            };
            let host = ServiceHost {
                client: Arc::new(client),
            };
            (Arc::new(host), status(state, Some(version), None))
        }
        Err(e) => (
            Arc::new(LocalHost),
            status(
                PtydState::Fallback,
                None,
                Some(CmdError::from(e).code.to_owned()),
            ),
        ),
    }
}

/// Picks the host from the stored setting, starting the service from the
/// `xdev-ptyd` next to the app when it is on. Runs off the main thread at
/// start; terminals wait for it.
pub(crate) fn start_host(ptys: &Ptys, terminal: &TerminalSettings, local_dir: Option<&Path>) {
    let version = xdev_core::version().to_string();
    let (host, status) = choose_host(terminal.service, &version, || {
        let local = local_dir.ok_or_else(|| ClientError {
            code: "ptyd_start_failed".into(),
            detail: Some("no local dir".into()),
        })?;
        let exe = std::env::current_exe().map_err(|e| ClientError {
            code: "ptyd_start_failed".into(),
            detail: Some(e.to_string()),
        })?;
        ensure(&StartOptions {
            dir: local.join(PTYD_DIR),
            binary: binary_beside(&exe),
            app_version: version.clone(),
            ring_mb: terminal.ring_mb,
            ..StartOptions::default()
        })
    });
    ptys.set_host(host, status);
}

/// The folder under the local dir the service keeps its files in.
pub(crate) const PTYD_DIR: &str = "ptyd";

/// The service binary the app ships next to its own exe.
pub(crate) fn binary_beside(exe: &Path) -> PathBuf {
    exe.with_file_name(format!("xdev-ptyd{}", std::env::consts::EXE_SUFFIX))
}

pub(crate) fn status(
    state: PtydState,
    service_version: Option<String>,
    reason: Option<String>,
) -> PtydStatus {
    PtydStatus {
        state,
        service_version,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_service_is_not_started_when_the_setting_is_off() {
        let (host, status) = choose_host(false, "1.0.0", || panic!("started"));
        assert_eq!(status.state, PtydState::Off);
        assert!(host.service().is_none());
    }

    #[test]
    fn a_service_that_does_not_start_falls_back_to_the_app() {
        let (host, status) = choose_host(true, "1.0.0", || {
            Err(ClientError {
                code: "ptyd_start_failed".into(),
                detail: None,
            })
        });
        assert_eq!(status.state, PtydState::Fallback);
        assert_eq!(status.reason.as_deref(), Some("ptyd_start_failed"));
        assert!(host.service().is_none());
    }

    #[test]
    fn service_codes_map_to_ones_the_ui_knows() {
        let err = |code: &str| {
            CmdError::from(ClientError {
                code: code.into(),
                detail: None,
            })
            .code
        };
        assert_eq!(err("pty_gone"), "pty_gone");
        assert_eq!(err("ptyd_version"), "ptyd_version");
        assert_eq!(err("something_new"), "ptyd_unreachable");
    }
}
