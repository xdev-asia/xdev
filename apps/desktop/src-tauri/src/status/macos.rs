//! What macOS says about notifications from this app.

use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2_foundation::NSBundle;
use objc2_user_notifications::{
    UNAuthorizationStatus, UNNotificationSettings, UNUserNotificationCenter,
};

use super::NotificationPermission;

/// How long the OS gets to answer before the state reads as unknown.
const ANSWER_WITHIN: Duration = Duration::from_secs(2);

/// The app's bundle id; `None` in a process that is not a bundle (a dev run).
pub fn bundle_id() -> Option<String> {
    NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|id| id.to_string())
        .filter(|id| !id.is_empty())
}

/// The OS authorisation for this app. Without a bundle id the notification
/// centre cannot be asked (it raises), so the answer is `Unknown`.
pub fn authorization() -> NotificationPermission {
    if bundle_id().is_none() {
        return NotificationPermission::Unknown;
    }
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // The settings object is valid for the duration of the handler.
        #[allow(unsafe_code)]
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = tx.send(status);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&handler);
    match rx.recv_timeout(ANSWER_WITHIN) {
        Ok(status) => map(status),
        Err(_) => NotificationPermission::Unknown,
    }
}

fn map(status: UNAuthorizationStatus) -> NotificationPermission {
    match status {
        UNAuthorizationStatus::Denied => NotificationPermission::Denied,
        UNAuthorizationStatus::NotDetermined => NotificationPermission::NotDetermined,
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => NotificationPermission::Authorized,
        _ => NotificationPermission::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A test binary is not an app bundle.
    #[test]
    fn unbundled_is_unknown() {
        assert_eq!(bundle_id(), None);
        assert_eq!(authorization(), NotificationPermission::Unknown);
    }
}
