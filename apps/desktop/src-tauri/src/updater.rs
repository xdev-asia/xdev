//! Signed updates from GitHub Releases (ADR 0005). Rust drives the plugin so
//! the webview needs no updater permission and no extra JS package.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::commands::CmdError;

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

fn update_error(e: tauri_plugin_updater::Error) -> CmdError {
    CmdError {
        code: "update",
        detail: Some(e.to_string()),
    }
}

/// `None` when this is the newest published release.
#[tauri::command(async)]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, CmdError> {
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        notes: u.body,
    }))
}

/// Checks again rather than trusting an earlier answer, since the release may
/// have been replaced since. Returns only when there was nothing to install.
#[tauri::command(async)]
pub async fn update_install(app: AppHandle) -> Result<(), CmdError> {
    let updater = app.updater().map_err(update_error)?;
    let Some(update) = updater.check().await.map_err(update_error)? else {
        return Ok(());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(update_error)?;
    app.restart()
}
