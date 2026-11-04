//! Saving the clipboard image for a terminal paste: the UI writes the returned path to the pty.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::Manager;
use uuid::Uuid;

use crate::commands::CmdError;

/// Most pixels an image may have (32 Mi).
pub const PASTE_MAX_PIXELS: u64 = 32 * 1024 * 1024;
/// Most bytes the encoded PNG may take (18 Mi).
pub const PASTE_MAX_BYTES: usize = 18_874_368;
/// A saved paste older than this is deleted the next time one is saved.
pub const PASTE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Most saved pastes kept; the oldest go first. After more than this many pastes within 24 h the
/// cap drops a recent paste, even one an agent has not read yet. Accepted.
pub const PASTE_MAX_FILES: usize = 50;

const PASTE_PREFIX: &str = "xdev-paste-";

/// The clipboard as the command sees it; `ArboardSource` in the app, a fake in tests.
pub trait ImageSource {
    /// Width, height and RGBA bytes; `None` when the clipboard holds no image.
    fn rgba(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, CmdError>;
}

fn io_error(detail: impl ToString) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(detail.to_string()),
    }
}

fn too_large() -> CmdError {
    CmdError {
        code: "too_large",
        detail: None,
    }
}

/// Encodes RGBA pixels as a PNG. `too_large` when over the pixel or byte cap, `io` on a bad buffer.
#[cfg_attr(not(test), allow(dead_code))]
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, CmdError> {
    encode_png_capped(width, height, rgba, PASTE_MAX_BYTES)
}

fn encode_png_capped(
    width: u32,
    height: u32,
    rgba: &[u8],
    max_bytes: usize,
) -> Result<Vec<u8>, CmdError> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > PASTE_MAX_PIXELS {
        return Err(too_large());
    }
    if width == 0 || height == 0 || rgba.len() as u64 != pixels * 4 {
        return Err(io_error(
            "the clipboard image buffer does not match its size",
        ));
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(io_error)?;
        writer.write_image_data(rgba).map_err(io_error)?;
        writer.finish().map_err(io_error)?;
    }
    if out.len() > max_bytes {
        return Err(too_large());
    }
    Ok(out)
}

/// The file name of a paste: a random v4 id, so a name cannot be guessed.
pub fn paste_file_name(id: Uuid) -> String {
    format!("{PASTE_PREFIX}{id}.png")
}

/// Creates the folder for pastes, owner-only (0700) on unix. Idempotent.
pub fn prepare_dir(dir: &Path) -> Result<(), CmdError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(io_error)?;
        // An older folder may have been made with a looser mode.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(io_error)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir).map_err(io_error)
    }
}

/// Deletes pastes in `dir` older than `max_age` at `now`, then the oldest beyond `max_files`.
/// Only files this module named are touched; an error on one file is skipped.
pub fn sweep(dir: &Path, now: SystemTime, max_age: Duration, max_files: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut kept: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(PASTE_PREFIX) && name.ends_with(".png")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age > max_age {
            let _ = std::fs::remove_file(entry.path());
        } else {
            kept.push((modified, entry.path()));
        }
    }
    if kept.len() > max_files {
        kept.sort();
        let extra = kept.len() - max_files;
        for (_, path) in kept.into_iter().take(extra) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Creates the file new (never over an existing one), 0600 on unix, and writes `bytes`.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CmdError> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)
}

/// Writes the clipboard image to `dir` (made if missing, owner-only) after sweeping old pastes;
/// `None` (and no file) when the clipboard holds none.
pub fn save_image(
    src: &mut dyn ImageSource,
    dir: &Path,
    now: SystemTime,
    id: Uuid,
) -> Result<Option<PathBuf>, CmdError> {
    save_image_capped(src, dir, now, id, PASTE_MAX_BYTES)
}

fn save_image_capped(
    src: &mut dyn ImageSource,
    dir: &Path,
    now: SystemTime,
    id: Uuid,
    max_bytes: usize,
) -> Result<Option<PathBuf>, CmdError> {
    let Some((width, height, rgba)) = src.rgba()? else {
        return Ok(None);
    };
    let png = encode_png_capped(width, height, &rgba, max_bytes)?;
    prepare_dir(dir)?;
    // Room for the one about to be written.
    sweep(dir, now, PASTE_MAX_AGE, PASTE_MAX_FILES - 1);
    let path = dir.join(paste_file_name(id));
    write_private(&path, &png)?;
    Ok(Some(path))
}

/// The system clipboard, read with arboard.
struct ArboardSource;

impl ImageSource for ArboardSource {
    fn rgba(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, CmdError> {
        let mut clipboard = arboard::Clipboard::new().map_err(io_error)?;
        // arboard decodes the whole image before it hands it over, so the pixel cap in
        // `encode_png_capped` cannot spare that memory; it only refuses what comes next.
        match clipboard.get_image() {
            Ok(img) => {
                let width = u32::try_from(img.width).map_err(|_| too_large())?;
                let height = u32::try_from(img.height).map_err(|_| too_large())?;
                Ok(Some((width, height, img.bytes.into_owned())))
            }
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(io_error(e)),
        }
    }
}

/// Saves the clipboard image as a PNG in the app's own cache folder (`paste/`); `None` when there
/// is no image.
#[tauri::command]
pub async fn clipboard_image_save(app: tauri::AppHandle) -> Result<Option<String>, CmdError> {
    let dir = app.path().app_cache_dir().map_err(io_error)?.join("paste");
    tauri::async_runtime::spawn_blocking(move || {
        let path = save_image(&mut ArboardSource, &dir, SystemTime::now(), Uuid::new_v4())?;
        Ok(path.map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(io_error)?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Option<(u32, u32, Vec<u8>)>);

    impl ImageSource for Fake {
        fn rgba(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, CmdError> {
            Ok(self.0.take())
        }
    }

    fn two_by_two() -> Fake {
        Fake(Some((2, 2, (0..16).collect())))
    }

    fn now() -> SystemTime {
        SystemTime::now()
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"x").unwrap();
        path
    }

    #[test]
    fn no_image_means_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let got = save_image(&mut Fake(None), dir.path(), now(), Uuid::nil()).unwrap();
        assert_eq!(got, None);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn an_image_is_saved_as_a_named_png() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let path = save_image(&mut two_by_two(), dir.path(), now(), id)
            .unwrap()
            .unwrap();
        assert_eq!(path, dir.path().join(format!("xdev-paste-{id}.png")));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 2));
        assert_eq!(&buf[..16], &(0..16).collect::<Vec<u8>>()[..]);
    }

    #[test]
    fn over_the_pixel_cap_is_too_large_before_encoding() {
        // 8192 x 4097 > 32 Mi pixels; the (empty) buffer is never looked at.
        let err = encode_png(8192, 4097, &[]).unwrap_err();
        assert_eq!(err.code, "too_large");
    }

    #[test]
    fn over_the_byte_cap_is_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let err =
            save_image_capped(&mut two_by_two(), dir.path(), now(), Uuid::nil(), 10).unwrap_err();
        assert_eq!(err.code, "too_large");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_short_buffer_is_an_io_error() {
        let err = encode_png(2, 2, &[0; 15]).unwrap_err();
        assert_eq!(err.code, "io");
    }

    #[test]
    fn the_folder_is_made_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a").join("paste");
        let path = save_image(&mut two_by_two(), &sub, now(), Uuid::new_v4())
            .unwrap()
            .unwrap();
        assert!(path.is_file());
    }

    #[test]
    fn names_differ_per_id_and_hold_no_clock() {
        let a = paste_file_name(Uuid::new_v4());
        let b = paste_file_name(Uuid::new_v4());
        assert_ne!(a, b);
        assert!(a.starts_with("xdev-paste-") && a.ends_with(".png"));
    }

    #[test]
    fn a_file_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let path = touch(dir.path(), &paste_file_name(id));
        let err = save_image(&mut two_by_two(), dir.path(), now(), id).unwrap_err();
        assert_eq!(err.code, "io");
        assert_eq!(std::fs::read(path).unwrap(), b"x");
    }

    #[test]
    fn sweep_deletes_old_pastes_and_only_pastes() {
        let dir = tempfile::tempdir().unwrap();
        let old = touch(dir.path(), "xdev-paste-old.png");
        let other = touch(dir.path(), "notes.png");
        let later = now() + PASTE_MAX_AGE + Duration::from_secs(60);
        sweep(dir.path(), later, PASTE_MAX_AGE, 50);
        assert!(!old.exists());
        assert!(other.exists());
        let fresh = touch(dir.path(), "xdev-paste-new.png");
        sweep(dir.path(), now(), PASTE_MAX_AGE, 50);
        assert!(fresh.exists());
    }

    #[test]
    fn sweep_keeps_at_most_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            touch(dir.path(), &format!("xdev-paste-{i}.png"));
        }
        sweep(dir.path(), now(), PASTE_MAX_AGE, 3);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[test]
    fn saving_keeps_the_folder_within_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..PASTE_MAX_FILES + 5 {
            touch(dir.path(), &format!("xdev-paste-{i}.png"));
        }
        save_image(&mut two_by_two(), dir.path(), now(), Uuid::new_v4())
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            PASTE_MAX_FILES
        );
    }

    #[cfg(unix)]
    #[test]
    fn folder_and_file_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("paste");
        let path = save_image(&mut two_by_two(), &sub, now(), Uuid::new_v4())
            .unwrap()
            .unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&sub), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
}
