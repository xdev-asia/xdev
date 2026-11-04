//! Signed updates from GitHub Releases (ADR 0005). Rust drives the updater and
//! notification plugins so the webview needs no permission and no extra JS
//! package. Updates download in the background and install on restart or quit,
//! so agents that are running are never cut off.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::CmdError;
use crate::settings::{SettingsSection, UpdateChannel};
use crate::settings_store;

const RECHECK: Duration = Duration::from_secs(6 * 3600);
const READY_EVENT: &str = "update-ready";
const PHASE_EVENT: &str = "update-phase";

const STABLE_ENDPOINT: &str =
    "https://github.com/xdev-asia/xdev/releases/latest/download/latest.json";
const RC_ENDPOINT: &str =
    "https://github.com/xdev-asia/xdev/releases/download/rc-latest/latest.json";

/// The manifest a channel follows. The stable one is also in `tauri.conf.json`.
pub fn endpoint(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => STABLE_ENDPOINT,
        UpdateChannel::Rc => RC_ENDPOINT,
    }
}

/// The download progress in whole percent; `None` while the size is unknown.
fn percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    Some((downloaded.saturating_mul(100) / total).min(100) as u8)
}

/// What a failed check reads as. No release on the release candidate feed is
/// normal until one is published, so it is "up to date", not an error.
fn error_phase(channel: UpdateChannel, e: &tauri_plugin_updater::Error) -> UpdatePhase {
    match (channel, e) {
        (UpdateChannel::Rc, tauri_plugin_updater::Error::ReleaseNotFound) => UpdatePhase::UpToDate,
        _ => UpdatePhase::Error {
            detail: e.to_string(),
        },
    }
}

/// The phase a check that found `found` (if anything) ends in.
fn found_phase(found: Option<UpdateInfo>) -> UpdatePhase {
    match found {
        None => UpdatePhase::UpToDate,
        Some(i) => UpdatePhase::Ready {
            version: i.version,
            notes: i.notes,
        },
    }
}

/// The phase now, shared by the 6 hour loop and the commands. A check or a
/// download in flight is the single flight: a second one gets the phase back.
pub struct Phase(Mutex<UpdatePhase>);

impl Default for Phase {
    fn default() -> Self {
        Self(Mutex::new(UpdatePhase::Idle))
    }
}

impl Phase {
    fn get(&self) -> UpdatePhase {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, next: UpdatePhase) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }

    /// Moves to `Checking` unless a check or download is already running; then
    /// the running one's phase is the error.
    fn begin(&self) -> Result<(), UpdatePhase> {
        let mut now = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match &*now {
            UpdatePhase::Checking | UpdatePhase::Downloading { .. } => Err(now.clone()),
            _ => {
                *now = UpdatePhase::Checking;
                Ok(())
            }
        }
    }
}

fn publish(app: &AppHandle, next: UpdatePhase) {
    app.state::<Phase>().set(next.clone());
    let _ = app.emit(PHASE_EVENT, next);
}

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Where a manual or background update check stands; the UI shows it in
/// Settings → General → Updates. Sent as the `update-phase` event on change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
    Error {
        detail: String,
    },
}

/// The downloaded, verified-on-install update waiting for a restart or quit.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

impl Pending {
    fn take(&self) -> Option<(Update, Vec<u8>)> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn put(&self, update: Update, bytes: Vec<u8>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
    }

    fn version(&self) -> Option<String> {
        let pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        pending.as_ref().map(|(u, _)| u.version.clone())
    }

    fn info(&self) -> Option<UpdateInfo> {
        let pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        pending.as_ref().map(|(u, _)| info(u))
    }
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    }
}

/// `check()` only reports releases newer than the running app, so any version
/// other than the pending one is worth downloading.
fn needs_download(pending: Option<&str>, found: &str) -> bool {
    pending != Some(found)
}

fn update_error(e: tauri_plugin_updater::Error) -> CmdError {
    CmdError {
        code: "update",
        detail: Some(e.to_string()),
    }
}

/// Checks now and every [`RECHECK`] on its own thread, so a slow download
/// never holds up the async runtime the commands share.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        loop {
            let phase = tauri::async_runtime::block_on(run_check(&app));
            // Offline or no release yet: try again next round, quietly.
            if let Some(UpdatePhase::Error { detail }) = &phase {
                eprintln!("update check failed: {detail}");
            }
            thread::sleep(RECHECK);
        }
    });
}

/// One check, and the download of what it finds, publishing every phase.
/// `None` when another check is already running.
async fn run_check(app: &AppHandle) -> Option<UpdatePhase> {
    let phases = app.state::<Phase>();
    if phases.begin().is_err() {
        return None;
    }
    publish(app, UpdatePhase::Checking);
    let channel = settings_store::read(app).shell.update_channel;
    let end = match check_once(app, channel).await {
        Ok(phase) => phase,
        Err(e) => error_phase(channel, &e),
    };
    publish(app, end.clone());
    Some(end)
}

async fn check_once(
    app: &AppHandle,
    channel: UpdateChannel,
) -> tauri_plugin_updater::Result<UpdatePhase> {
    let updater = match channel {
        UpdateChannel::Stable => app.updater()?,
        UpdateChannel::Rc => {
            let url = tauri::Url::parse(endpoint(channel)).expect("a fixed, valid url");
            app.updater_builder().endpoints(vec![url])?.build()?
        }
    };
    let Some(update) = updater.check().await? else {
        return Ok(UpdatePhase::UpToDate);
    };
    let pending = app.state::<Pending>();
    if !needs_download(pending.version().as_deref(), &update.version) {
        return Ok(found_phase(pending.info()));
    }
    let version = update.version.clone();
    publish(
        app,
        UpdatePhase::Downloading {
            version: version.clone(),
            percent: None,
        },
    );
    let mut downloaded = 0u64;
    let mut shown = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let now = percent(downloaded, total);
                if now != shown {
                    shown = now;
                    publish(
                        app,
                        UpdatePhase::Downloading {
                            version: version.clone(),
                            percent: now,
                        },
                    );
                }
            },
            || {},
        )
        .await?;
    let ready = info(&update);
    pending.put(update, bytes);
    let _ = app.emit(READY_EVENT, ready.clone());
    Ok(found_phase(Some(ready)))
}

/// Installs whatever is pending; called as the app exits.
pub fn install_pending(app: &AppHandle) {
    if let Some((update, bytes)) = app.state::<Pending>().take()
        && let Err(e) = update.install(bytes)
    {
        eprintln!("update install on quit failed: {e}");
    }
}

/// The downloaded update ready to install, if any.
#[tauri::command]
pub fn update_status(pending: State<'_, Pending>) -> Option<UpdateInfo> {
    pending.info()
}

/// Installs the pending update and relaunches. Resolves only when nothing was
/// pending.
#[tauri::command(async)]
pub fn update_restart(app: AppHandle, pending: State<'_, Pending>) -> Result<(), CmdError> {
    let Some((update, bytes)) = pending.take() else {
        return Ok(());
    };
    if let Err(e) = update.install(&bytes) {
        // Kept so a retry or quitting can still install it.
        pending.put(update, bytes);
        return Err(update_error(e));
    }
    app.restart()
}

/// A check the person asked for. `rc` also stores the release candidate
/// channel, which the later checks keep following. Resolves with where the
/// check ended, or the phase of the check that was already running.
#[tauri::command(async)]
pub async fn update_check(app: AppHandle, rc: bool) -> Result<UpdatePhase, CmdError> {
    if rc && settings_store::read(&app).shell.update_channel != UpdateChannel::Rc {
        settings_store::write(&app, &[SettingsSection::Shell], |s| {
            s.shell.update_channel = UpdateChannel::Rc;
        })?;
    }
    Ok(match run_check(&app).await {
        Some(phase) => phase,
        None => app.state::<Phase>().get(),
    })
}

/// Where the update check stands now.
#[tauri::command]
pub fn update_phase(phase: State<'_, Phase>) -> UpdatePhase {
    phase.get()
}

/// An OS notification; the UI passes the text so it is in the user's language.
#[tauri::command]
pub fn update_notify(app: AppHandle, title: String, body: String) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("notification failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_only_a_version_not_already_pending() {
        assert!(needs_download(None, "0.3.0"));
        assert!(!needs_download(Some("0.3.0"), "0.3.0"));
        assert!(needs_download(Some("0.3.0"), "0.3.1"));
    }

    #[test]
    fn each_channel_has_its_own_manifest() {
        assert_eq!(
            endpoint(UpdateChannel::Stable),
            "https://github.com/xdev-asia/xdev/releases/latest/download/latest.json"
        );
        assert_eq!(
            endpoint(UpdateChannel::Rc),
            "https://github.com/xdev-asia/xdev/releases/download/rc-latest/latest.json"
        );
    }

    #[test]
    fn the_stable_endpoint_is_the_one_in_the_config() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(endpoint(UpdateChannel::Stable)));
    }

    #[test]
    fn percent_comes_from_the_chunks_and_the_total() {
        assert_eq!(percent(0, Some(200)), Some(0));
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(200, Some(200)), Some(100));
        assert_eq!(percent(500, Some(200)), Some(100));
        assert_eq!(percent(10, None), None);
        assert_eq!(percent(10, Some(0)), None);
    }

    #[test]
    fn no_release_on_the_rc_feed_reads_as_up_to_date() {
        let missing = tauri_plugin_updater::Error::ReleaseNotFound;
        assert_eq!(
            error_phase(UpdateChannel::Rc, &missing),
            UpdatePhase::UpToDate
        );
        assert!(matches!(
            error_phase(UpdateChannel::Stable, &missing),
            UpdatePhase::Error { .. }
        ));
    }

    #[test]
    fn a_check_that_finds_nothing_ends_up_to_date() {
        assert_eq!(found_phase(None), UpdatePhase::UpToDate);
        let ready = found_phase(Some(UpdateInfo {
            version: "0.4.0".into(),
            notes: Some("fixes".into()),
        }));
        assert_eq!(
            ready,
            UpdatePhase::Ready {
                version: "0.4.0".into(),
                notes: Some("fixes".into())
            }
        );
    }

    #[test]
    fn a_second_check_gets_the_running_phase_back() {
        let phase = Phase::default();
        assert_eq!(phase.get(), UpdatePhase::Idle);
        assert_eq!(phase.begin(), Ok(()));
        assert_eq!(phase.begin(), Err(UpdatePhase::Checking));
        let downloading = UpdatePhase::Downloading {
            version: "0.4.0".into(),
            percent: Some(40),
        };
        phase.set(downloading.clone());
        assert_eq!(phase.begin(), Err(downloading));
        // Once it ended, a new check may start.
        phase.set(UpdatePhase::UpToDate);
        assert_eq!(phase.begin(), Ok(()));
        phase.set(UpdatePhase::Ready {
            version: "0.4.0".into(),
            notes: None,
        });
        assert_eq!(phase.begin(), Ok(()));
    }

    #[test]
    fn phases_serialise_with_a_kind_tag() {
        let json = serde_json::to_value(UpdatePhase::Downloading {
            version: "0.4.0".into(),
            percent: None,
        })
        .unwrap();
        assert_eq!(json["kind"], "downloading");
        assert_eq!(json["percent"], serde_json::Value::Null);
        assert_eq!(
            serde_json::to_value(UpdatePhase::UpToDate).unwrap()["kind"],
            "up-to-date"
        );
    }
}
