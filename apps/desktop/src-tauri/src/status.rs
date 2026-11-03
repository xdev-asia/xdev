//! How agent status reaches the person outside the panes: its settings, OS
//! notifications, the taskbar or dock badge and the person's own sound.

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::ipc::{InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::commands::{AppState, CmdError};
use crate::settings::StatusSettings;
use crate::settings_store::{self, SettingsStore};

/// The largest own sound the app copies and plays.
const MAX_SOUND: u64 = 1024 * 1024;
const SOUND_EXTS: [&str; 3] = ["wav", "mp3", "ogg"];
const SOUNDS_DIR: &str = "sounds";
pub const CLICK_EVENT: &str = "status://notification-click";
/// Notifications whose click can still be told apart; older ones are gone.
const KEEP_SHOWN: usize = 64;

/// The payload of `CLICK_EVENT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationClick {
    pty_id: String,
}

/// The pane each recent notification was shown for, by notification id.
#[derive(Default)]
pub struct Shown {
    next: AtomicI32,
    recent: Mutex<VecDeque<(i32, String)>>,
}

impl Shown {
    fn add(&self, pty_id: &str) -> i32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let mut recent = self.recent.lock().unwrap_or_else(PoisonError::into_inner);
        if recent.len() == KEEP_SHOWN {
            recent.pop_front();
        }
        recent.push_back((id, pty_id.to_owned()));
        id
    }

    fn pty_of(&self, id: i32) -> Option<String> {
        let recent = self.recent.lock().unwrap_or_else(PoisonError::into_inner);
        recent
            .iter()
            .rev()
            .find(|(n, _)| *n == id)
            .map(|(_, p)| p.clone())
    }
}

/// Reports a click on a status notification as `CLICK_EVENT`. Must run before
/// the first notification: the plugin reports clicks only on notifications
/// shown after a handler exists.
pub fn listen_clicks(app: &AppHandle) {
    let emitter = app.clone();
    let registered = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let Some(shown) = performed.notification() else {
            return;
        };
        let pty_id = shown
            .extra()
            .get("ptyId")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| emitter.state::<Shown>().pty_of(shown.id()));
        if let Some(pty_id) = pty_id {
            let _ = emitter.emit(CLICK_EVENT, NotificationClick { pty_id });
        }
    });
    if let Err(e) = registered {
        eprintln!("notification clicks: {e}");
    }
}

fn io_error(e: io::Error) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

fn bad_sound(detail: impl Into<String>) -> CmdError {
    CmdError {
        code: "bad_sound",
        detail: Some(detail.into()),
    }
}

fn store_of(app: &AppHandle) -> Result<&SettingsStore, CmdError> {
    settings_store::store(app)
        .map(|s| s.inner())
        .ok_or_else(|| io_error(io::Error::other("no config dir")))
}

/// Stores `next`, except the sound file, which only `status_sound_set` sets.
fn put(store: &SettingsStore, next: StatusSettings) -> io::Result<StatusSettings> {
    let saved = store.update(|s| {
        s.status = StatusSettings {
            volume: next.volume.min(100),
            sound_file: s.status.sound_file.take(),
            ..next
        };
    })?;
    Ok(saved.status)
}

/// Makes the `.off` marker match the stored `status.hooks`. Run at startup,
/// so a marker left over from another session (or a settings file that
/// roamed in without one) does not keep hooks quiet, or on, behind the
/// setting's back.
pub fn sync_hooks_marker(store: &SettingsStore, local_dir: &Path) -> io::Result<bool> {
    let on = store.read().status.hooks;
    xdev_agent::set_hooks_off(local_dir, !on)?;
    Ok(on)
}

/// Copies `src` to `<data_dir>/sounds/custom.<ext>`, or clears the setting
/// for `None`; a copy left from an earlier pick stays on disk.
fn set_sound(
    store: &SettingsStore,
    data_dir: &Path,
    src: Option<&Path>,
) -> Result<StatusSettings, CmdError> {
    let stored = match src {
        None => None,
        Some(src) => Some(copy_sound(data_dir, src)?),
    };
    let saved = store
        .update(|s| s.status.sound_file = stored.map(|p| p.display().to_string()))
        .map_err(io_error)?;
    Ok(saved.status)
}

fn copy_sound(data_dir: &Path, src: &Path) -> Result<PathBuf, CmdError> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| SOUND_EXTS.contains(&e.as_str()))
        .ok_or_else(|| bad_sound("not a wav, mp3 or ogg file"))?;
    let meta = fs::metadata(src).map_err(|e| bad_sound(e.to_string()))?;
    if !meta.is_file() || meta.len() > MAX_SOUND {
        return Err(bad_sound(format!("{} bytes", meta.len())));
    }
    let dir = data_dir.join(SOUNDS_DIR);
    fs::create_dir_all(&dir).map_err(io_error)?;
    let dest = dir.join(format!("custom.{ext}"));
    // Copying a file onto itself would empty it.
    let same = matches!(
        (fs::canonicalize(src), fs::canonicalize(&dest)),
        (Ok(a), Ok(b)) if a == b
    );
    if !same {
        fs::copy(src, &dest).map_err(io_error)?;
    }
    Ok(dest)
}

/// The own sound's bytes, when one is set, still there and not too big.
fn sound_bytes(status: &StatusSettings) -> Option<Vec<u8>> {
    let path = Path::new(status.sound_file.as_deref()?);
    if fs::metadata(path).ok()?.len() > MAX_SOUND {
        return None;
    }
    fs::read(path).ok()
}

/// A red dot for the Windows taskbar overlay, 16×16 RGBA.
#[cfg_attr(not(windows), allow(dead_code))]
fn overlay_dot() -> Vec<u8> {
    const SIZE: u32 = 16;
    let centre = (SIZE as f32 - 1.0) / 2.0;
    let radius = SIZE as f32 / 2.0 - 1.0;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 - centre).powi(2) + (y as f32 - centre).powi(2)).sqrt();
            // One pixel of soft edge.
            let alpha = ((radius + 0.5 - d).clamp(0.0, 1.0) * 255.0) as u8;
            rgba.extend_from_slice(&[0xe5, 0x48, 0x4d, alpha]);
        }
    }
    rgba
}

#[tauri::command(async)]
pub fn status_settings_get(app: AppHandle) -> StatusSettings {
    settings_store::read(&app).status
}

#[tauri::command(async)]
pub fn status_settings_put(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: StatusSettings,
) -> Result<StatusSettings, CmdError> {
    let stored = put(store_of(&app)?, settings).map_err(io_error)?;
    // The marker `xdev agent-hook` checks, so switching hooks off also
    // quiets panes launched while they were on. Best effort.
    if let Some(local) = state.local_dir.as_deref()
        && let Err(e) = xdev_agent::set_hooks_off(local, !stored.hooks)
    {
        eprintln!("hooks marker: {e}");
    }
    Ok(stored)
}

/// A notification the OS refused or could not show, as the `io` error the
/// Test button reports. Logged too.
fn shown_or_error(result: Result<(), impl std::fmt::Display>) -> Result<(), CmdError> {
    result.map_err(|e| {
        eprintln!("status notification: {e}");
        io_error(io::Error::other(e.to_string()))
    })
}

/// Fails with `io` when the OS refused or could not show it; the notifier
/// treats that as best effort, the Test button shows it.
#[tauri::command(async)]
pub fn status_notify(
    app: AppHandle,
    shown: State<'_, Shown>,
    title: String,
    body: String,
    pty_id: String,
) -> Result<(), CmdError> {
    let id = shown.add(&pty_id);
    let result = app
        .notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .extra("ptyId", &pty_id)
        .show();
    shown_or_error(result)
}

/// `0` clears the badge. Never fails; an OS without badges shows nothing.
#[tauri::command]
pub fn status_badge(app: AppHandle, count: u32) {
    let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
    else {
        return;
    };
    #[cfg(windows)]
    let result = window.set_overlay_icon(
        (count > 0).then(|| tauri::image::Image::new_owned(overlay_dot(), 16, 16)),
    );
    #[cfg(not(windows))]
    let result = window.set_badge_count((count > 0).then_some(i64::from(count)));
    if let Err(e) = result {
        eprintln!("status badge: {e}");
    }
}

#[tauri::command(async)]
pub fn status_sound_set(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<StatusSettings, CmdError> {
    let data_dir = crate::accounts::data_dir(&state)?;
    set_sound(store_of(&app)?, data_dir, path.as_deref().map(Path::new))
}

/// Raw bytes, or JSON `null` when there is no own sound to play.
#[tauri::command(async)]
pub fn status_sound(app: AppHandle) -> Response {
    let status = settings_store::read(&app).status;
    match sound_bytes(&status) {
        Some(bytes) => Response::new(InvokeResponseBody::Raw(bytes)),
        None => Response::new(InvokeResponseBody::Json("null".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::settings;

    struct Dirs {
        _tmp: tempfile::TempDir,
        store: SettingsStore,
        data: PathBuf,
        src: PathBuf,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(tmp.path().join("config").join(settings::FILE_NAME));
        let data = tmp.path().join("data");
        let src = tmp.path().join("pick");
        fs::create_dir_all(&src).unwrap();
        Dirs {
            store,
            data,
            src,
            _tmp: tmp,
        }
    }

    #[test]
    fn sound_set_copies_and_refuses_bad_files() {
        let d = dirs();
        let good = d.src.join("Ding.WAV");
        fs::write(&good, b"RIFF....").unwrap();
        let status = set_sound(&d.store, &d.data, Some(&good)).unwrap();
        let dest = d.data.join("sounds").join("custom.wav");
        assert_eq!(
            status.sound_file.as_deref(),
            Some(dest.display().to_string().as_str())
        );
        assert_eq!(fs::read(&dest).unwrap(), b"RIFF....");
        assert_eq!(d.store.read().status, status);
        assert_eq!(sound_bytes(&status).unwrap(), b"RIFF....");

        // Picking the stored copy again keeps its bytes.
        let again = set_sound(&d.store, &d.data, Some(&dest)).unwrap();
        assert_eq!(again.sound_file, status.sound_file);
        assert_eq!(fs::read(&dest).unwrap(), b"RIFF....");

        let text = d.src.join("notes.txt");
        fs::write(&text, b"x").unwrap();
        let big = d.src.join("big.mp3");
        fs::write(&big, vec![0u8; MAX_SOUND as usize + 1]).unwrap();
        let missing = d.src.join("gone.ogg");
        for bad in [&text, &big, &missing, &d.src] {
            let err = set_sound(&d.store, &d.data, Some(bad)).unwrap_err();
            assert_eq!(err.code, "bad_sound", "{}", bad.display());
        }
        // A refused file leaves the stored sound alone.
        assert_eq!(d.store.read().status.sound_file, status.sound_file);

        let exact = d.src.join("edge.ogg");
        fs::write(&exact, vec![1u8; MAX_SOUND as usize]).unwrap();
        let ogg = set_sound(&d.store, &d.data, Some(&exact)).unwrap();
        assert!(ogg.sound_file.unwrap().ends_with("custom.ogg"));

        let cleared = set_sound(&d.store, &d.data, None).unwrap();
        assert_eq!(cleared.sound_file, None);
        assert_eq!(sound_bytes(&cleared), None);
    }

    #[test]
    fn sound_bytes_is_none_when_the_file_is_gone() {
        let status = StatusSettings {
            sound_file: Some("definitely/not/here.wav".to_owned()),
            ..StatusSettings::default()
        };
        assert_eq!(sound_bytes(&status), None);
    }

    #[test]
    fn a_refused_notification_is_an_io_error() {
        assert!(shown_or_error(Ok::<(), String>(())).is_ok());
        let err = shown_or_error(Err("toast refused")).unwrap_err();
        assert_eq!(err.code, "io");
        assert_eq!(err.detail.as_deref(), Some("toast refused"));
    }

    #[test]
    fn startup_sync_makes_the_marker_follow_the_setting() {
        let d = dirs();
        let local = d.data.join("local");
        let marker = local
            .join(xdev_agent::HOOKS_DIR)
            .join(xdev_agent::HOOKS_OFF);
        // No settings file: hooks are on, a stale marker goes.
        xdev_agent::set_hooks_off(&local, true).unwrap();
        assert!(sync_hooks_marker(&d.store, &local).unwrap());
        assert!(!marker.exists());
        // Stored off: the marker appears.
        let off = StatusSettings {
            hooks: false,
            ..StatusSettings::default()
        };
        put(&d.store, off).unwrap();
        assert!(!sync_hooks_marker(&d.store, &local).unwrap());
        assert!(marker.is_file());
        // Running it again changes nothing.
        assert!(!sync_hooks_marker(&d.store, &local).unwrap());
        assert!(marker.is_file());
    }

    #[test]
    fn settings_put_clamps_volume() {
        let d = dirs();
        let next = StatusSettings {
            volume: 250,
            os: false,
            ..StatusSettings::default()
        };
        let stored = put(&d.store, next).unwrap();
        assert_eq!(stored.volume, 100);
        assert!(!stored.os);
        assert_eq!(d.store.read().status, stored);
    }

    #[test]
    fn settings_put_keeps_other_settings_and_the_sound_file() {
        let d = dirs();
        d.store
            .update(|s| {
                s.last_vault = Some("vault".to_owned());
                s.status.sound_file = Some("kept.wav".to_owned());
            })
            .unwrap();
        let next = StatusSettings {
            sound_file: Some("from-ui.wav".to_owned()),
            volume: 30,
            ..StatusSettings::default()
        };
        let stored = put(&d.store, next).unwrap();
        assert_eq!(stored.sound_file.as_deref(), Some("kept.wav"));
        assert_eq!(stored.volume, 30);
        assert_eq!(d.store.read().last_vault.as_deref(), Some("vault"));
    }

    #[test]
    fn overlay_dot_is_16_by_16_rgba() {
        let dot = overlay_dot();
        assert_eq!(dot.len(), 16 * 16 * 4);
        let alpha = |x: usize, y: usize| dot[(y * 16 + x) * 4 + 3];
        assert_eq!(alpha(0, 0), 0);
        assert_eq!(alpha(7, 7), 255);
        assert_eq!(alpha(8, 8), 255);
    }

    #[test]
    fn shown_maps_ids_to_panes_and_forgets_old_ones() {
        let shown = Shown::default();
        let first = shown.add("a");
        let second = shown.add("b");
        assert_ne!(first, second);
        assert_eq!(shown.pty_of(first).as_deref(), Some("a"));
        assert_eq!(shown.pty_of(second).as_deref(), Some("b"));
        for _ in 0..KEEP_SHOWN {
            shown.add("c");
        }
        assert_eq!(shown.pty_of(first), None);
    }
}
