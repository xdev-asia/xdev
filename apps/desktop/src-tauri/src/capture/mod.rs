//! Screen capture: the OS picks a region, the image lands in the paste folder
//! and `capture://ready` tells the window. Each OS grab lives in its own file;
//! what happens to the image after is pure and tested here.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::cli_verbs::Ctx;
use crate::clipboard::{self, ImageSource, PASTE_MAX_BYTES, PASTE_MAX_PIXELS};
use crate::commands::CmdError;
use crate::endpoint::{AppError, Caller, Request};
use crate::settings::{CaptureSettings, SettingsSection};
use crate::settings_store;

mod linux;
mod mac;
pub mod permission;
pub mod shortcut;
mod win;

pub use permission::CapturePermission;
pub use shortcut::ShortcutStatus;

pub const READY_EVENT: &str = "capture://ready";
pub const FAILED_EVENT: &str = "capture://failed";

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

/// The payload of `READY_EVENT`: the saved PNG and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CaptureReady {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// The payload of `FAILED_EVENT`; the UI translates `code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CaptureFailed {
    pub code: String,
    pub message: String,
}

/// One capture at a time; `cancel` stops a grab that waits (Windows).
#[derive(Default)]
pub struct CaptureHub {
    busy: AtomicBool,
    cancel: AtomicBool,
}

impl CaptureHub {
    /// Marks a capture as running; `capture_busy` when one already is.
    fn claim(&self) -> Result<(), CmdError> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(err("capture_busy", None));
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Stops a grab that is waiting; called when the app exits.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

/// What an OS grab hands back.
pub(crate) enum Shot {
    Png(Vec<u8>),
    /// Pixels from the clipboard (Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    Rgba(u32, u32, Vec<u8>),
}

pub(crate) fn err(code: &'static str, detail: impl Into<Option<String>>) -> CmdError {
    CmdError {
        code,
        detail: detail.into(),
    }
}

pub(crate) fn io_error(detail: impl ToString) -> CmdError {
    err("io", detail.to_string())
}

/// A fresh file in the paste folder for a tool to write to. It is named like
/// a paste, so `clipboard::sweep` removes one a crash left behind.
fn temp_png(dir: &Path) -> Result<PathBuf, CmdError> {
    clipboard::prepare_dir(dir)?;
    Ok(dir.join(clipboard::paste_file_name(Uuid::new_v4())))
}

/// The bytes a tool wrote to `path`, then the file is gone; `None` when it
/// wrote nothing.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", test)),
    allow(dead_code)
)]
pub(crate) fn take_file(path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok();
    let _ = std::fs::remove_file(path);
    bytes.filter(|b| !b.is_empty())
}

/// The OS grab: `None` when the person cancelled. A tool that writes a file
/// writes it to `tmp`.
fn grab(hub: &CaptureHub, tmp: &Path) -> Result<Option<Shot>, CmdError> {
    #[cfg(target_os = "macos")]
    {
        let _ = hub;
        mac::grab(tmp)
    }
    #[cfg(windows)]
    {
        let _ = tmp;
        win::grab(&hub.cancel)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = hub;
        linux::grab(tmp)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = (hub, tmp);
        Err(err("capture_no_tool", None))
    }
}

/// Width, height and RGBA bytes of a PNG. `too_large` past `PASTE_MAX_PIXELS`,
/// read from the header before any pixel is decoded.
pub(crate) fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), CmdError> {
    let limits = png::Limits {
        bytes: (PASTE_MAX_PIXELS * 4) as usize + 1024 * 1024,
    };
    let mut decoder = png::Decoder::new_with_limits(Cursor::new(bytes), limits);
    let info = decoder.read_header_info().map_err(io_error)?;
    if u64::from(info.width) * u64::from(info.height) > PASTE_MAX_PIXELS {
        return Err(err("too_large", None));
    }
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(io_error)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| err("too_large", None))?;
    let mut buf = vec![0; size];
    let frame = reader.next_frame(&mut buf).map_err(io_error)?;
    buf.truncate(frame.buffer_size());
    let rgba = match frame.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err(io_error("an indexed PNG was not expanded")),
    };
    Ok((frame.width, frame.height, rgba))
}

/// Pixels already decoded, handed to `clipboard::save_image` once.
struct Pixels(Option<(u32, u32, Vec<u8>)>);

impl ImageSource for Pixels {
    fn rgba(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, CmdError> {
        Ok(self.0.take())
    }
}

/// The image step: checks the size, saves the PNG into `dir` the way a
/// clipboard paste is saved and says what to emit.
pub(crate) fn store(
    shot: Shot,
    dir: &Path,
    now: SystemTime,
    id: Uuid,
) -> Result<CaptureReady, CmdError> {
    let (width, height, rgba) = match shot {
        Shot::Png(bytes) => decode_png(&bytes)?,
        Shot::Rgba(w, h, rgba) => {
            if u64::from(w) * u64::from(h) > PASTE_MAX_PIXELS {
                return Err(err("too_large", None));
            }
            (w, h, rgba)
        }
    };
    let path = clipboard::save_image(&mut Pixels(Some((width, height, rgba))), dir, now, id)?
        .ok_or_else(|| io_error("no image to save"))?;
    Ok(CaptureReady {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

/// `bytes` as a PNG written by the app (the annotated image): checked,
/// decoded and encoded again before it is saved.
pub(crate) fn save_png(
    bytes: &[u8],
    dir: &Path,
    now: SystemTime,
    id: Uuid,
) -> Result<String, CmdError> {
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(io_error("not a PNG"));
    }
    if bytes.len() > PASTE_MAX_BYTES {
        return Err(err("too_large", None));
    }
    store(Shot::Png(bytes.to_vec()), dir, now, id).map(|r| r.path)
}

/// The bytes of `path`, which must resolve to a file inside `dir`; `outside`
/// for anything else, a link out included.
pub(crate) fn read_inside(dir: &Path, path: &Path) -> Result<Vec<u8>, CmdError> {
    let dir = dunce::canonicalize(dir).map_err(io_error)?;
    let path = dunce::canonicalize(path).map_err(|_| err("outside", None))?;
    if path.parent() != Some(dir.as_path()) || !path.is_file() {
        return Err(err("outside", None));
    }
    std::fs::read(&path).map_err(io_error)
}

fn paste_dir(app: &AppHandle) -> Result<PathBuf, CmdError> {
    Ok(app.path().app_cache_dir().map_err(io_error)?.join("paste"))
}

/// The grab, then the image step, in the paste folder.
fn run(app: &AppHandle, hub: &CaptureHub) -> Result<Option<CaptureReady>, CmdError> {
    let dir = paste_dir(app)?;
    let Some(shot) = grab(hub, &temp_png(&dir)?)? else {
        return Ok(None);
    };
    store(shot, &dir, SystemTime::now(), Uuid::new_v4()).map(Some)
}

fn finish(app: &AppHandle, ready: Result<Option<CaptureReady>, CmdError>) {
    match ready {
        Ok(None) => {}
        Ok(Some(ready)) => {
            crate::cli_file::bring_to_front(app);
            let _ = app.emit(READY_EVENT, ready);
        }
        Err(e) => {
            let failed = CaptureFailed {
                code: e.code.to_owned(),
                message: e.detail.unwrap_or_else(|| e.code.to_owned()),
            };
            let _ = app.emit(FAILED_EVENT, failed);
        }
    }
}

/// Starts a capture in the background; `capture_busy` while one runs.
pub fn start(app: &AppHandle) -> Result<(), CmdError> {
    start_with(app, &app.state::<CaptureHub>())
}

fn start_with(app: &AppHandle, hub: &CaptureHub) -> Result<(), CmdError> {
    hub.claim()?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let hub = app.state::<CaptureHub>();
        let ready = run(&app, &hub);
        hub.busy.store(false, Ordering::SeqCst);
        finish(&app, ready);
    });
    Ok(())
}

/// The handle the CLI verb needs; `Ctx` carries none.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Once at start-up, after the settings store: keeps the handle and sets the
/// shortcut.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    shortcut::apply(app);
}

/// `capture.start` from `xdev capture`.
pub fn cli_start(_ctx: &Ctx<'_>, _req: &Request, _caller: &Caller) -> Result<Value, AppError> {
    let app = APP
        .get()
        .ok_or_else(|| AppError::new("io", "the app is starting"))?;
    start(app).map_err(|e| AppError::new(e.code, "a capture is already running"))?;
    Ok(json!({ "started": true }))
}

#[tauri::command(async)]
pub fn capture_start(app: AppHandle, hub: State<'_, CaptureHub>) -> Result<(), CmdError> {
    start_with(&app, &hub)
}

/// Saves a PNG the window made (an annotated capture) in the paste folder.
#[tauri::command]
pub async fn capture_save_png(app: AppHandle, bytes: Vec<u8>) -> Result<String, CmdError> {
    let dir = paste_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_png(&bytes, &dir, SystemTime::now(), Uuid::new_v4())
    })
    .await
    .map_err(io_error)?
}

/// The bytes of a capture in the paste folder.
#[tauri::command(async)]
pub fn capture_read(app: AppHandle, path: String) -> Result<Vec<u8>, CmdError> {
    read_inside(&paste_dir(&app)?, Path::new(&path))
}

#[tauri::command(async)]
pub fn capture_permission() -> CapturePermission {
    permission::status()
}

#[tauri::command(async)]
pub fn capture_open_privacy(app: AppHandle) -> Result<(), CmdError> {
    permission::open_privacy(&app)
}

#[tauri::command(async)]
pub fn capture_shortcut_apply(app: AppHandle) -> ShortcutStatus {
    shortcut::apply(&app)
}

/// Settings → Screenshots as stored; the defaults when nothing is.
#[tauri::command(async)]
pub fn capture_settings_get(app: AppHandle) -> CaptureSettings {
    settings_store::read(&app).capture
}

/// Stores Settings → Screenshots, then sets the shortcut again.
#[tauri::command(async)]
pub fn capture_settings_put(
    app: AppHandle,
    settings: CaptureSettings,
) -> Result<CaptureSettings, CmdError> {
    let saved = settings_store::write(&app, &[SettingsSection::Capture], |s| s.capture = settings)
        .map(|s| s.capture)?;
    shortcut::apply(&app);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let rgba: Vec<u8> = (0..width * height * 4).map(|i| i as u8).collect();
        clipboard::encode_png(width, height, &rgba).unwrap()
    }

    /// A PNG header claiming `width` × `height`, with no pixel data.
    fn header_only(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        let encoder = {
            let mut e = png::Encoder::new(&mut out, width, height);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            e
        };
        drop(encoder.write_header().unwrap());
        out
    }

    #[test]
    fn one_capture_at_a_time() {
        let hub = CaptureHub::default();
        hub.cancel();
        assert!(hub.claim().is_ok());
        assert!(!hub.cancel.load(Ordering::SeqCst));
        assert_eq!(hub.claim().unwrap_err().code, "capture_busy");
        hub.busy.store(false, Ordering::SeqCst);
        assert!(hub.claim().is_ok());
    }

    #[test]
    fn a_png_is_saved_and_ready_is_built() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let ready = store(Shot::Png(png(3, 2)), dir.path(), SystemTime::now(), id).unwrap();
        assert_eq!((ready.width, ready.height), (3, 2));
        let path = PathBuf::from(&ready.path);
        assert_eq!(path, dir.path().join(clipboard::paste_file_name(id)));
        let (w, h, rgba) = decode_png(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!((w, h), (3, 2));
        assert_eq!(rgba, (0..24).map(|i| i as u8).collect::<Vec<_>>());
    }

    #[test]
    fn rgba_from_the_clipboard_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let ready = store(
            Shot::Rgba(1, 1, vec![1, 2, 3, 4]),
            dir.path(),
            SystemTime::now(),
            Uuid::new_v4(),
        )
        .unwrap();
        assert_eq!((ready.width, ready.height), (1, 1));
    }

    #[test]
    fn over_the_pixel_cap_is_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let big = header_only(8193, 4096);
        let e = store(
            Shot::Png(big),
            dir.path(),
            SystemTime::now(),
            Uuid::new_v4(),
        )
        .unwrap_err();
        assert_eq!(e.code, "too_large");
        let e = store(
            Shot::Rgba(8193, 4096, Vec::new()),
            dir.path(),
            SystemTime::now(),
            Uuid::new_v4(),
        )
        .unwrap_err();
        assert_eq!(e.code, "too_large");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn rgb_and_grey_pngs_become_rgba() {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, 1, 1);
            e.set_color(png::ColorType::Grayscale);
            e.set_depth(png::BitDepth::Eight);
            let mut w = e.write_header().unwrap();
            w.write_image_data(&[7]).unwrap();
        }
        assert_eq!(decode_png(&out).unwrap(), (1, 1, vec![7, 7, 7, 255]));
    }

    #[test]
    fn save_png_refuses_other_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        for bytes in [&b""[..], b"GIF89a....", b"\x89PNX\r\n\x1a\n"] {
            let e = save_png(bytes, dir.path(), now, Uuid::new_v4()).unwrap_err();
            assert_eq!(e.code, "io");
        }
        // A signature with nothing after it fails to decode.
        let e = save_png(&PNG_SIGNATURE, dir.path(), now, Uuid::new_v4()).unwrap_err();
        assert_eq!(e.code, "io");
        assert!(save_png(&png(2, 2), dir.path(), now, Uuid::new_v4()).is_ok());
    }

    #[test]
    fn read_inside_takes_only_files_in_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("paste");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("a.png"), b"a").unwrap();
        std::fs::write(root.path().join("secret"), b"s").unwrap();

        assert_eq!(read_inside(&dir, &dir.join("a.png")).unwrap(), b"a");
        let outside = |p: PathBuf| read_inside(&dir, &p).unwrap_err().code;
        assert_eq!(outside(dir.join("../secret")), "outside");
        assert_eq!(outside(root.path().join("secret")), "outside");
        assert_eq!(outside(dir.join("missing.png")), "outside");
        assert_eq!(outside(dir.clone()), "outside");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("secret"), dir.join("link.png")).unwrap();
            assert_eq!(outside(dir.join("link.png")), "outside");
        }
    }

    #[test]
    fn take_file_treats_empty_as_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.png");
        assert_eq!(take_file(&path), None);
        std::fs::write(&path, b"").unwrap();
        assert_eq!(take_file(&path), None);
        assert!(!path.exists());
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(take_file(&path), Some(b"x".to_vec()));
        assert!(!path.exists());
    }
}
