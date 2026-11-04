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

const RECHECK: Duration = Duration::from_secs(6 * 3600);
const READY_EVENT: &str = "update-ready";

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
            if let Err(e) = tauri::async_runtime::block_on(check_once(&app)) {
                // Offline or no release yet: try again next round.
                eprintln!("update check failed: {e}");
            }
            thread::sleep(RECHECK);
        }
    });
}

async fn check_once(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let pending = app.state::<Pending>();
    if !needs_download(pending.version().as_deref(), &update.version) {
        return Ok(());
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    let ready = info(&update);
    pending.put(update, bytes);
    let _ = app.emit(READY_EVENT, ready);
    Ok(())
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

/// An OS notification; the UI passes the text so it is in the user's language.
#[tauri::command]
pub fn update_notify(app: AppHandle, title: String, body: String) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("notification failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::needs_download;

    #[test]
    fn downloads_only_a_version_not_already_pending() {
        assert!(needs_download(None, "0.3.0"));
        assert!(!needs_download(Some("0.3.0"), "0.3.0"));
        assert!(needs_download(Some("0.3.0"), "0.3.1"));
    }
}
