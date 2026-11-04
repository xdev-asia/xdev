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

pub fn encode_png(_width: u32, _height: u32, _rgba: &[u8]) -> Result<Vec<u8>, CmdError> {
    Err(not_implemented())
}

pub fn paste_file_name(_now_ms: u128, _id: Uuid) -> String {
    String::new()
}

pub fn save_image(
    _src: &mut dyn ImageSource,
    _dir: &Path,
    _now_ms: u128,
    _id: Uuid,
) -> Result<Option<PathBuf>, CmdError> {
    Ok(None)
}

fn not_implemented() -> CmdError {
    CmdError {
        code: "io",
        detail: Some("not implemented".into()),
    }
}

/// Saves the clipboard image as a PNG in the temp folder; `None` when there is no image.
#[tauri::command]
pub async fn clipboard_image_save() -> Result<Option<String>, CmdError> {
    Ok(None)
}
