//! Saving the clipboard image for a terminal paste: the UI writes the returned path to the pty.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::commands::CmdError;

/// Most pixels an image may have (32 Mi).
pub const PASTE_MAX_PIXELS: u64 = 32 * 1024 * 1024;
/// Most bytes the encoded PNG may take (18 Mi).
pub const PASTE_MAX_BYTES: usize = 18_874_368;

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

pub fn paste_file_name(now_ms: u128, id: Uuid) -> String {
    format!("xdev-paste-{now_ms}-{id}.png")
}

/// Writes the clipboard image to `dir`; `None` (and no file) when the clipboard holds none.
pub fn save_image(
    src: &mut dyn ImageSource,
    dir: &Path,
    now_ms: u128,
    id: Uuid,
) -> Result<Option<PathBuf>, CmdError> {
    save_image_capped(src, dir, now_ms, id, PASTE_MAX_BYTES)
}

fn save_image_capped(
    src: &mut dyn ImageSource,
    dir: &Path,
    now_ms: u128,
    id: Uuid,
    max_bytes: usize,
) -> Result<Option<PathBuf>, CmdError> {
    let Some((width, height, rgba)) = src.rgba()? else {
        return Ok(None);
    };
    let png = encode_png_capped(width, height, &rgba, max_bytes)?;
    let path = dir.join(paste_file_name(now_ms, id));
    std::fs::write(&path, png).map_err(io_error)?;
    Ok(Some(path))
}

/// The system clipboard, read with arboard.
struct ArboardSource;

impl ImageSource for ArboardSource {
    fn rgba(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, CmdError> {
        let mut clipboard = arboard::Clipboard::new().map_err(io_error)?;
        match clipboard.get_image() {
            Ok(img) => Ok(Some((
                img.width as u32,
                img.height as u32,
                img.bytes.into_owned(),
            ))),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(io_error(e)),
        }
    }
}

/// Saves the clipboard image as a PNG in the temp folder; `None` when there is no image.
#[tauri::command]
pub async fn clipboard_image_save() -> Result<Option<String>, CmdError> {
    tauri::async_runtime::spawn_blocking(|| {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let path = save_image(
            &mut ArboardSource,
            &std::env::temp_dir(),
            now_ms,
            Uuid::new_v4(),
        )?;
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

    #[test]
    fn no_image_means_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let got = save_image(&mut Fake(None), dir.path(), 1, Uuid::nil()).unwrap();
        assert_eq!(got, None);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn an_image_is_saved_as_a_named_png() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let path = save_image(&mut two_by_two(), dir.path(), 1234, id)
            .unwrap()
            .unwrap();
        assert_eq!(path, dir.path().join(format!("xdev-paste-1234-{id}.png")));
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
        let err = save_image_capped(&mut two_by_two(), dir.path(), 1, Uuid::nil(), 10).unwrap_err();
        assert_eq!(err.code, "too_large");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_short_buffer_is_an_io_error() {
        let err = encode_png(2, 2, &[0; 15]).unwrap_err();
        assert_eq!(err.code, "io");
    }
}
