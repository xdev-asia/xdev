//! The macOS keyboard input source, for the "Option as Alt" auto mode.

/// The current macOS keyboard input source id ("com.apple.keylayout.US"); `None` elsewhere or on failure.
#[tauri::command]
pub async fn keyboard_input_source(_app: tauri::AppHandle) -> Option<String> {
    None
}
