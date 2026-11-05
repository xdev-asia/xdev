//! The current keyboard input source id on macOS ("com.apple.keylayout.US").
//! Every other OS has none.

#[cfg(target_os = "macos")]
mod mac;

/// The current keyboard input source id, such as "com.apple.keylayout.US".
/// `None` off macOS, or when macOS reports no source.
///
/// Main thread only: the Text Input Sources calls assert the main queue on
/// recent macOS.
pub fn current_input_source_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        mac::current_input_source_id()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn there_is_no_input_source_off_macos() {
        assert_eq!(current_input_source_id(), None);
    }
}
