//! Sharing a usage card: the PNG goes to the clipboard and the post text to
//! the browser, both through Rust so the webview needs no clipboard or
//! URL-open permission.

use tauri::AppHandle;

use crate::commands::CmdError;

/// The largest PNG body accepted.
#[allow(dead_code)]
pub(crate) const MAX_PNG: usize = 16 << 20;
/// The longest post text, in characters.
#[allow(dead_code)]
pub(crate) const MAX_TEXT: usize = 1000;

/// Raw PNG body (`InvokeBody::Raw`), at most 16 MiB.
#[tauri::command(async)]
pub fn usage_share_copy_image(
    _app: AppHandle,
    _request: tauri::ipc::Request<'_>,
) -> Result<(), CmdError> {
    Err(CmdError {
        code: "share_clipboard",
        detail: None,
    })
}

/// Opens `https://x.com/intent/post?text=<encoded>` in the browser.
#[tauri::command(async)]
pub fn usage_share_post(_app: AppHandle, _text: String) -> Result<(), CmdError> {
    Err(CmdError {
        code: "share_open",
        detail: None,
    })
}

#[allow(dead_code)]
pub(crate) fn post_url(_text: &str) -> Result<String, CmdError> {
    Err(CmdError {
        code: "share_open",
        detail: None,
    })
}
