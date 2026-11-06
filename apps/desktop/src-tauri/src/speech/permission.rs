//! The OS microphone permission. macOS asks through AVFoundation, Windows
//! keeps a privacy switch in the registry, Linux asks nothing.

use serde::Serialize;
use tauri::AppHandle;

use crate::commands::CmdError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MicPermission {
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    Granted,
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    Denied,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NotDetermined,
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    NotNeeded,
}

/// The page of System Settings or Windows Settings that holds the switch.
pub fn privacy_url() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    } else if cfg!(windows) {
        Some("ms-settings:privacy-microphone")
    } else {
        None
    }
}

/// Opens the privacy page; a no-op where there is none.
pub fn open_privacy(app: &AppHandle) -> Result<(), CmdError> {
    use crate::history::UrlOpener;
    match privacy_url() {
        Some(url) => crate::history::PluginOpener(app).open(url),
        None => Ok(()),
    }
}

/// The consent values under the user and machine keys (the key itself and
/// its `NonPackaged` subkey): any `Deny` blocks the app.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn consent_from_values(user: &[&str], machine: &[&str]) -> MicPermission {
    if user
        .iter()
        .chain(machine)
        .any(|v| v.eq_ignore_ascii_case("deny"))
    {
        MicPermission::Denied
    } else {
        MicPermission::Granted
    }
}

pub fn status() -> MicPermission {
    #[cfg(target_os = "macos")]
    {
        mac::status()
    }
    #[cfg(windows)]
    {
        win::status()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        MicPermission::NotNeeded
    }
}

/// Asks the OS where it can (macOS, first time only), then reads the state.
pub fn request() -> MicPermission {
    #[cfg(target_os = "macos")]
    {
        mac::request()
    }
    #[cfg(not(target_os = "macos"))]
    {
        status()
    }
}

#[cfg(windows)]
mod win {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

    use super::{MicPermission, consent_from_values};

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn values(root: winreg::HKEY) -> Vec<String> {
        let root = RegKey::predef(root);
        [KEY.to_owned(), format!(r"{KEY}\NonPackaged")]
            .iter()
            .filter_map(|path| root.open_subkey_with_flags(path, KEY_READ).ok())
            .filter_map(|key| key.get_value::<String, _>("Value").ok())
            .collect()
    }

    pub fn status() -> MicPermission {
        let user = values(HKEY_CURRENT_USER);
        let machine = values(HKEY_LOCAL_MACHINE);
        let user: Vec<&str> = user.iter().map(String::as_str).collect();
        let machine: Vec<&str> = machine.iter().map(String::as_str).collect();
        consent_from_values(&user, &machine)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    use super::MicPermission;

    /// The person may leave the OS prompt open for a while.
    const ANSWER_WITHIN: Duration = Duration::from_secs(120);

    #[link(name = "AVFoundation", kind = "framework")]
    #[allow(unsafe_code)]
    unsafe extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    fn media_audio() -> &'static NSString {
        // SAFETY: a constant NSString exported by AVFoundation.
        #[allow(unsafe_code)]
        unsafe {
            AVMediaTypeAudio
        }
    }

    pub fn status() -> MicPermission {
        // SAFETY: a class method that takes an AVMediaType and returns an
        // AVAuthorizationStatus (NSInteger).
        #[allow(unsafe_code)]
        let status: isize = unsafe {
            msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: media_audio()]
        };
        match status {
            0 => MicPermission::NotDetermined,
            3 => MicPermission::Granted,
            // 1 restricted, 2 denied.
            _ => MicPermission::Denied,
        }
    }

    pub fn request() -> MicPermission {
        if status() != MicPermission::NotDetermined {
            return status();
        }
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: a class method that takes an AVMediaType and a block
        // `void (^)(BOOL)`; AVFoundation copies the block.
        #[allow(unsafe_code)]
        let () = unsafe {
            msg_send![
                class!(AVCaptureDevice),
                requestAccessForMediaType: media_audio(),
                completionHandler: &*handler
            ]
        };
        let _ = rx.recv_timeout(ANSWER_WITHIN);
        status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_camel_case() {
        let json = |p| serde_json::to_string(&p).unwrap();
        assert_eq!(json(MicPermission::Granted), "\"granted\"");
        assert_eq!(json(MicPermission::Denied), "\"denied\"");
        assert_eq!(json(MicPermission::NotDetermined), "\"notDetermined\"");
        assert_eq!(json(MicPermission::NotNeeded), "\"notNeeded\"");
    }

    #[test]
    fn privacy_url_per_os() {
        #[cfg(target_os = "macos")]
        assert_eq!(
            privacy_url(),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        );
        #[cfg(windows)]
        assert_eq!(privacy_url(), Some("ms-settings:privacy-microphone"));
        #[cfg(not(any(target_os = "macos", windows)))]
        assert_eq!(privacy_url(), None);
    }

    #[test]
    fn consent_values() {
        assert_eq!(
            consent_from_values(&["Allow"], &["Deny"]),
            MicPermission::Denied
        );
        assert_eq!(consent_from_values(&["Allow"], &[]), MicPermission::Granted);
        assert_eq!(consent_from_values(&[], &[]), MicPermission::Granted);
        assert_eq!(
            consent_from_values(&["Deny", "Allow"], &["Allow"]),
            MicPermission::Denied
        );
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn linux_needs_nothing() {
        assert_eq!(status(), MicPermission::NotNeeded);
        assert_eq!(request(), MicPermission::NotNeeded);
    }
}
