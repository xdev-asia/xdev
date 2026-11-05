//! Where a terminal's process runs: in the app (`LocalHost`, as before the
//! service) or in the per-user `xdev-ptyd` service (`ServiceHost`), which
//! keeps it running when the app quits, updates or crashes.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use xdev_pty::client::{Attached, Client, ClientError, Sink, StartOptions, ensure, service_dir};
use xdev_pty::{Session, SpawnSpec};

use crate::commands::CmdError;
use crate::pty::{PtyHandle, PtydState, PtydStatus, Ptys};
use crate::settings_store;

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
            "ptyd_old" => "ptyd_old",
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

    /// Takes over the service's PTY `id`, replaying from `from_seq`;
    /// `pty_gone` when there is none (always, in the app).
    fn attach(
        &self,
        id: &str,
        from_seq: u64,
        sink: Sink,
    ) -> Result<(Box<dyn PtyHandle>, Attached), CmdError> {
        let _ = (id, from_seq, sink);
        Err(CmdError {
            code: "pty_gone",
            detail: None,
        })
    }

    /// The service behind this host; none for `LocalHost`.
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

    fn attach(
        &self,
        id: &str,
        from_seq: u64,
        sink: Sink,
    ) -> Result<(Box<dyn PtyHandle>, Attached), CmdError> {
        let attached = self.client.attach(id, from_seq, sink)?;
        let pty = ServicePty {
            client: self.client.clone(),
            id: id.to_owned(),
            pid: None,
        };
        Ok((Box::new(pty), attached))
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

    fn outlives_app(&self) -> bool {
        true
    }
}

/// `major.minor.patch` of a version, and whether a pre-release tag follows.
/// A part that is not a number reads as 0.
fn parse_version(v: &str) -> ([u64; 3], Option<&str>) {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next().unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let mut parts = [0u64; 3];
    for (slot, part) in parts.iter_mut().zip(core.split('.')) {
        *slot = part.parse().unwrap_or(0);
    }
    (parts, pre)
}

/// How the service's version ranks against the app's: numeric triples, and a
/// pre-release tag counts as older than the same release.
pub(crate) fn compare_versions(service: &str, app: &str) -> Ordering {
    let ((s, s_pre), (a, a_pre)) = (parse_version(service), parse_version(app));
    s.cmp(&a).then_with(|| match (s_pre, a_pre) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y),
    })
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
            let state = match compare_versions(&version, app_version) {
                Ordering::Equal => PtydState::Running,
                Ordering::Less => PtydState::OldVersion,
                // Held: a newer xDev owns this service. Nothing is ended
                // until the person reopens the terminals here.
                Ordering::Greater => {
                    let held = PtydStatus {
                        features: client.features().to_vec(),
                        ..status(PtydState::NewerVersion, Some(version), None)
                    };
                    return (Arc::new(LocalHost), held);
                }
            };
            let held = PtydStatus {
                features: client.features().to_vec(),
                ..status(state, Some(version), None)
            };
            let host = ServiceHost {
                client: Arc::new(client),
            };
            (Arc::new(host), held)
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
/// `xdev-ptyd` next to the app when it is on, and tells the UI. Runs off the
/// main thread; terminals wait for it. A service that drops later turns into
/// a fallback: new terminals run in the app.
pub(crate) fn start_host(app: &AppHandle, local_dir: Option<&Path>) {
    let terminal = settings_store::read(app).terminal;
    let version = xdev_core::version().to_string();
    let (host, picked) = choose_host(terminal.service, &version, || {
        let local = local_dir.ok_or_else(|| ClientError {
            code: "ptyd_start_failed".into(),
            detail: Some("no local dir".into()),
        })?;
        let exe = std::env::current_exe().map_err(|e| ClientError {
            code: "ptyd_start_failed".into(),
            detail: Some(e.to_string()),
        })?;
        let binary = find_binary(&exe).ok_or_else(|| ClientError {
            code: "ptyd_start_failed".into(),
            detail: Some(format!("no {BINARY} next to the app")),
        })?;
        if !terminal.save_scrollback {
            // Off also deletes what is saved, even when a running service
            // started before the switch was turned off.
            let _ = xdev_pty::snapshot::clear_all(&service_dir(local));
        }
        ensure(&StartOptions {
            dir: service_dir(local),
            binary,
            app_version: version.clone(),
            ring_mb: terminal.ring_mb,
            snapshots: terminal.save_scrollback,
            ..StartOptions::default()
        })
    });
    if let Some(client) = host.service() {
        let app = app.clone();
        let watched = Arc::downgrade(&client);
        client.on_close(move || {
            let ptys = app.state::<Ptys>();
            // Only the host this hook was set for; a restart has its own.
            let current = ptys.peek_host().and_then(|h| h.service());
            if current.is_some_and(|c| Weak::ptr_eq(&watched, &Arc::downgrade(&c))) {
                let fallback = status(
                    PtydState::Fallback,
                    None,
                    Some("ptyd_unreachable".to_owned()),
                );
                ptys.set_host(Arc::new(LocalHost), fallback.clone());
                let _ = app.emit(STATUS_EVENT, fallback);
            }
        });
    }
    ptys_set(app, host, picked);
}

fn ptys_set(app: &AppHandle, host: Arc<dyn PtyHost>, status: PtydStatus) {
    app.state::<Ptys>().set_host(host, status.clone());
    let _ = app.emit(STATUS_EVENT, status);
}

/// Ends the service and every PTY in it, then starts it again; from a
/// fallback, tries to start it (Retry).
pub(crate) fn restart(app: &AppHandle, local_dir: Option<&Path>) -> Result<(), CmdError> {
    let ptys = app.state::<Ptys>();
    if let Some(client) = ptys.host().service() {
        // New terminals wait while the service is swapped.
        ptys.clear_host();
        if client.quit_all().is_ok() {
            let start = Instant::now();
            while !client.closed() && start.elapsed() < RESTART_WAIT {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    start_host(app, local_dir);
    match ptys.host_status().1 {
        PtydStatus {
            state: PtydState::Fallback,
            reason,
            ..
        } => Err(CmdError {
            code: "ptyd_start_failed",
            detail: reason,
        }),
        _ => Ok(()),
    }
}

/// The `ptyd://status` event: where terminals run changed.
pub(crate) const STATUS_EVENT: &str = "ptyd://status";
const RESTART_WAIT: Duration = Duration::from_secs(5);

/// The service's name: the `[[bin]]` of `xdev-pty` and the `externalBin` of
/// `tauri.ptyd.conf.json`, which installs it next to the app.
pub(crate) const BINARY: &str = "xdev-ptyd";

/// The service binary next to the app's exe: where an installer puts the
/// sidecar, and where cargo and `scripts/ptyd-sidecar.mjs` put it in a dev
/// build.
pub(crate) fn find_binary(exe: &Path) -> Option<PathBuf> {
    let path = exe.with_file_name(format!("{BINARY}{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
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
        features: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_resolver_finds_the_binary_next_to_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir
            .path()
            .join(format!("xdev-desktop{}", std::env::consts::EXE_SUFFIX));
        assert_eq!(find_binary(&exe), None);
        let bin = dir
            .path()
            .join(format!("xdev-ptyd{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&bin, "").unwrap();
        assert_eq!(find_binary(&exe), Some(bin));
    }

    #[test]
    fn a_dev_build_has_the_binary_next_to_the_app() {
        // Test binaries live in `deps`; the app and the service one up.
        let exe = std::env::current_exe().unwrap();
        let app = exe.parent().unwrap().parent().unwrap().join("xdev-desktop");
        // `cargo test --workspace` builds every bin before a test runs.
        assert!(
            find_binary(&app).is_some(),
            "no {BINARY} next to {}; build the workspace or run scripts/ptyd-sidecar.mjs",
            app.display()
        );
    }

    #[test]
    fn the_bundle_ships_the_binary_the_resolver_looks_for() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.ptyd.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["externalBin"],
            serde_json::json!([format!("binaries/{BINARY}"), "binaries/xdev"])
        );
        let bin = here.join(format!("../../../crates/xdev-pty/src/bin/{BINARY}.rs"));
        assert!(bin.is_file(), "{}", bin.display());
        // The before commands build it, or a dev run and a bundle miss it.
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for cmd in ["beforeDevCommand", "beforeBuildCommand"] {
            let line = main["build"][cmd].as_str().unwrap();
            assert!(line.contains("scripts/ptyd-sidecar.mjs"), "{cmd}: {line}");
        }
        assert!(here.join("../scripts/ptyd-sidecar.mjs").is_file());
        // A bundle has it only with this config.
        let release = include_str!("../../../../.github/workflows/release.yml");
        assert!(release.contains("--config src-tauri/tauri.ptyd.conf.json"));
    }

    #[test]
    fn versions_compare_semver() {
        use Ordering::*;
        assert_eq!(compare_versions("0.7.0", "0.7.0"), Equal);
        assert_eq!(compare_versions("0.10.0", "0.9.5"), Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.1"), Less);
        assert_eq!(compare_versions("2.0.0", "1.99.99"), Greater);
        assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0"), Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-beta.1"), Greater);
        assert_eq!(compare_versions("v1.2.3+build5", "1.2.3"), Equal);
    }

    #[test]
    fn newer_service_is_held_local() {
        // A service whose version is above the app's is not used. Version
        // text is the whole test: the service is the real one in-process.
        let dir = tempfile::tempdir().unwrap();
        let ep = xdev_ipc::endpoint(dir.path(), "xdev-ptyd-held-test", xdev_pty::proto::PROTOCOL);
        let mut cfg = xdev_pty::service::Config::new(dir.path().to_owned(), 64 * 1024);
        cfg.endpoint = ep.clone();
        cfg.version = "99.0.0".into();
        let service = xdev_pty::service::start(cfg).unwrap();
        let handle = std::thread::spawn(move || service.wait());
        let (host, st) = choose_host(true, "1.0.0", || {
            xdev_pty::client::connect(dir.path(), &ep, "1.0.0")
        });
        assert_eq!(st.state, PtydState::NewerVersion);
        assert_eq!(st.service_version.as_deref(), Some("99.0.0"));
        assert!(st.features.iter().any(|f| f == "clear"));
        assert!(host.service().is_none());
        // An older app version meets an older service the old way.
        let (host, st) = choose_host(true, "99.0.0", || {
            xdev_pty::client::connect(dir.path(), &ep, "99.0.0")
        });
        assert_eq!(st.state, PtydState::Running);
        host.service().unwrap().quit_all().unwrap();
        handle.join().unwrap();
    }

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
