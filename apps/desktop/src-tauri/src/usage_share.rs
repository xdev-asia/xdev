//! Sharing a usage card: the PNG goes to the clipboard and the post text to
//! the browser, both through Rust so the webview needs no clipboard or
//! URL-open permission.

use std::fmt::Write as _;

use tauri::AppHandle;
use tauri::image::Image;
use tauri::ipc::InvokeBody;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::commands::CmdError;

/// The largest PNG body accepted.
pub(crate) const MAX_PNG: usize = 16 << 20;
/// The longest post text, in characters.
pub(crate) const MAX_TEXT: usize = 1000;

fn err(code: &'static str, detail: impl ToString) -> CmdError {
    CmdError {
        code,
        detail: Some(detail.to_string()),
    }
}

/// Raw PNG body (`InvokeBody::Raw`), at most 16 MiB.
#[tauri::command(async)]
pub fn usage_share_copy_image(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), CmdError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(err("share_bad_image", "the body is not raw bytes"));
    };
    let image = decode_png(bytes)?;
    app.clipboard()
        .write_image(&image)
        .map_err(|e| err("share_clipboard", e))
}

/// Opens `https://x.com/intent/post?text=<encoded>` in the browser.
#[tauri::command(async)]
pub fn usage_share_post(app: AppHandle, text: String) -> Result<(), CmdError> {
    let url = post_url(&text)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| err("share_open", e))
}

/// A PNG body as an image: refused when over `MAX_PNG` or not a PNG.
pub(crate) fn decode_png(bytes: &[u8]) -> Result<Image<'static>, CmdError> {
    if bytes.len() > MAX_PNG {
        return Err(CmdError {
            code: "share_too_large",
            detail: Some(format!("{} bytes", bytes.len())),
        });
    }
    Image::from_bytes(bytes).map_err(|e| err("share_bad_image", e))
}

/// The post intent URL with `text` percent-encoded; empty or over-long text
/// is refused.
pub(crate) fn post_url(text: &str) -> Result<String, CmdError> {
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT {
        return Err(CmdError {
            code: "share_open",
            detail: Some("the post text is empty or too long".to_owned()),
        });
    }
    let mut url = String::from("https://x.com/intent/post?text=");
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            url.push(char::from(b));
        } else {
            let _ = write!(url, "%{b:02X}");
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_post_url_encodes_every_reserved_character() {
        let url = post_url("a b\u{b7}c\nd&e=f").unwrap();
        assert_eq!(
            url,
            "https://x.com/intent/post?text=a%20b%C2%B7c%0Ad%26e%3Df"
        );
    }

    #[test]
    fn plain_text_stays_readable() {
        assert_eq!(
            post_url("Abc-1.2_3~").unwrap(),
            "https://x.com/intent/post?text=Abc-1.2_3~"
        );
    }

    #[test]
    fn the_post_text_is_bounded_in_characters() {
        assert!(post_url(&"\u{b7}".repeat(MAX_TEXT)).is_ok());
        assert_eq!(
            post_url(&"x".repeat(MAX_TEXT + 1)).unwrap_err().code,
            "share_open"
        );
        assert_eq!(post_url("  ").unwrap_err().code, "share_open");
    }

    #[test]
    fn a_body_over_the_limit_is_too_large() {
        let big = vec![0u8; MAX_PNG + 1];
        assert_eq!(decode_png(&big).unwrap_err().code, "share_too_large");
    }

    #[test]
    fn bytes_that_are_not_a_png_are_a_bad_image() {
        assert_eq!(
            decode_png(b"not a png").unwrap_err().code,
            "share_bad_image"
        );
        assert_eq!(decode_png(&[]).unwrap_err().code, "share_bad_image");
    }

    /// A 1x1 transparent PNG.
    const PNG_1X1: [u8; 68] = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn a_real_png_decodes() {
        let img = decode_png(&PNG_1X1).unwrap();
        assert_eq!((img.width(), img.height()), (1, 1));
    }
}
