//! The macOS keyboard input source, for the "Option as Alt" auto mode.

/// The current macOS keyboard input source id ("com.apple.keylayout.US"); `None` elsewhere or on failure.
#[tauri::command]
pub async fn keyboard_input_source(app: tauri::AppHandle) -> Option<String> {
    input_source(&app).await
}

/// Off macOS there is no input source to read; nothing is touched.
#[cfg(not(target_os = "macos"))]
async fn input_source(_app: &tauri::AppHandle) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
async fn input_source(app: &tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;
    use std::time::Duration;

    // The TIS calls assert the main queue on recent macOS, so they run there.
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(mac::current_input_source_id());
    })
    .ok()?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)).ok())
        .await
        .ok()?
        .flatten()
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        static kTISPropertyInputSourceID: CFStringRef;
        fn TISCopyCurrentKeyboardInputSource() -> CFTypeRef;
        fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
    }

    /// A CFString the caller does not own, as a Rust string; `None` for null.
    pub fn cfstring_to_string(s: CFStringRef) -> Option<String> {
        if s.is_null() {
            return None;
        }
        // SAFETY: `s` is a live CFString; "get" rule means we retain our own reference.
        Some(unsafe { CFString::wrap_under_get_rule(s) }.to_string())
    }

    /// Main thread only.
    pub fn current_input_source_id() -> Option<String> {
        // SAFETY: called on the main thread; the copied source is released below, the property
        // (get rule) is read before that.
        unsafe {
            let source = TISCopyCurrentKeyboardInputSource();
            if source.is_null() {
                return None;
            }
            let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
            let out = cfstring_to_string(id as CFStringRef);
            CFRelease(source);
            out
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_cfstring_becomes_a_string_and_null_becomes_none() {
            let s = CFString::new("com.apple.keylayout.US");
            assert_eq!(
                cfstring_to_string(s.as_concrete_TypeRef()).as_deref(),
                Some("com.apple.keylayout.US")
            );
            assert_eq!(cfstring_to_string(std::ptr::null()), None);
        }
    }
}
