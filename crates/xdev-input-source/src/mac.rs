//! The Carbon Text Input Sources calls.

use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};

// SAFETY: these are the Carbon declarations from TextInputSources.h: the key is
// an immutable CFString constant, the copy function follows the create rule and
// the property getter follows the get rule.
#[allow(unsafe_code)]
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyInputSourceID: CFStringRef;
    fn TISCopyCurrentKeyboardInputSource() -> CFTypeRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
}

/// A CFString the caller does not own, as a Rust string; `None` for null.
#[allow(unsafe_code)]
fn cfstring_to_string(s: CFStringRef) -> Option<String> {
    if s.is_null() {
        return None;
    }
    // SAFETY: `s` is a live CFString; "get" rule means we retain our own reference.
    Some(unsafe { CFString::wrap_under_get_rule(s) }.to_string())
}

/// Main thread only.
#[allow(unsafe_code)]
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
