//! Tokens live only in the OS keychain, bound to the host they were tested against.

use serde::{Deserialize, Serialize};

use crate::http::Secret;
use crate::{TOKEN_MAX, TrackerError, TrackerKind};

pub trait TrackerKeys: Send + Sync {
    /// `None` when absent, unreadable as a blob, or bound to a different host.
    fn get(&self, kind: TrackerKind, host: &str) -> Result<Option<Secret>, TrackerError>;
    fn set(&self, kind: TrackerKind, host: &str, token: &str) -> Result<(), TrackerError>;
    fn remove(&self, kind: TrackerKind) -> Result<bool, TrackerError>;
}

#[derive(Serialize, Deserialize)]
struct Blob {
    h: String,
    t: String,
}

fn user(kind: TrackerKind) -> &'static str {
    match kind {
        TrackerKind::Linear => "tracker-linear",
        TrackerKind::Jira => "tracker-jira",
    }
}

fn encode(host: &str, token: &str) -> Result<String, TrackerError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(TrackerError::EmptyKey);
    }
    if token.chars().count() > TOKEN_MAX {
        return Err(TrackerError::TooLarge);
    }
    serde_json::to_string(&Blob {
        h: host.to_owned(),
        t: token.to_owned(),
    })
    .map_err(|_| TrackerError::SecretStore)
}

fn decode(raw: &str, host: &str) -> Option<Secret> {
    let blob: Blob = serde_json::from_str(raw).ok()?;
    (blob.h == host && !blob.t.is_empty()).then(|| Secret::new(blob.t))
}

pub struct Keychain;

fn entry(kind: TrackerKind) -> Result<keyring::Entry, TrackerError> {
    keyring::Entry::new("xdev", user(kind)).map_err(|_| TrackerError::SecretStore)
}

impl TrackerKeys for Keychain {
    fn get(&self, kind: TrackerKind, host: &str) -> Result<Option<Secret>, TrackerError> {
        match entry(kind)?.get_password() {
            Ok(raw) => Ok(decode(&raw, host)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(TrackerError::SecretStore),
        }
    }

    fn set(&self, kind: TrackerKind, host: &str, token: &str) -> Result<(), TrackerError> {
        let blob = encode(host, token)?;
        entry(kind)?
            .set_password(&blob)
            .map_err(|_| TrackerError::SecretStore)
    }

    fn remove(&self, kind: TrackerKind) -> Result<bool, TrackerError> {
        match entry(kind)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(TrackerError::SecretStore),
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use memory::MemoryKeys;

#[cfg(any(test, feature = "test-util"))]
mod memory {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    #[derive(Default)]
    pub struct MemoryKeys {
        blobs: Mutex<BTreeMap<&'static str, String>>,
        fail: AtomicBool,
    }

    impl MemoryKeys {
        pub fn new() -> Self {
            Self::default()
        }

        /// Makes every call fail with `SecretStore`, like a broken keychain.
        pub fn set_fail(&self, fail: bool) {
            self.fail.store(fail, Ordering::SeqCst);
        }

        /// The stored blob as the keychain would hold it.
        pub fn raw(&self, kind: TrackerKind) -> Option<String> {
            self.blobs.lock().unwrap().get(user(kind)).cloned()
        }

        pub fn put_raw(&self, kind: TrackerKind, raw: &str) {
            self.blobs
                .lock()
                .unwrap()
                .insert(user(kind), raw.to_owned());
        }

        pub fn is_empty(&self) -> bool {
            self.blobs.lock().unwrap().is_empty()
        }

        fn check(&self) -> Result<(), TrackerError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(TrackerError::SecretStore)
            } else {
                Ok(())
            }
        }
    }

    impl TrackerKeys for MemoryKeys {
        fn get(&self, kind: TrackerKind, host: &str) -> Result<Option<Secret>, TrackerError> {
            self.check()?;
            Ok(self
                .blobs
                .lock()
                .unwrap()
                .get(user(kind))
                .and_then(|raw| decode(raw, host)))
        }

        fn set(&self, kind: TrackerKind, host: &str, token: &str) -> Result<(), TrackerError> {
            self.check()?;
            let blob = encode(host, token)?;
            self.blobs.lock().unwrap().insert(user(kind), blob);
            Ok(())
        }

        fn remove(&self, kind: TrackerKind) -> Result<bool, TrackerError> {
            self.check()?;
            Ok(self.blobs.lock().unwrap().remove(user(kind)).is_some())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_trims_and_get_is_host_bound() {
        let k = MemoryKeys::new();
        k.set(TrackerKind::Linear, "api.linear.app", "  tok  ")
            .unwrap();
        let got = k.get(TrackerKind::Linear, "api.linear.app").unwrap();
        assert_eq!(got.unwrap().expose(), "tok");
        assert!(k.get(TrackerKind::Linear, "other.host").unwrap().is_none());
    }

    #[test]
    fn blob_shape_and_garbage() {
        let k = MemoryKeys::new();
        k.set(TrackerKind::Linear, "api.linear.app", "tok").unwrap();
        assert_eq!(
            k.raw(TrackerKind::Linear).unwrap(),
            r#"{"h":"api.linear.app","t":"tok"}"#
        );
        k.put_raw(TrackerKind::Jira, "not json");
        assert!(
            k.get(TrackerKind::Jira, "acme.atlassian.net")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn length_limits() {
        let k = MemoryKeys::new();
        assert_eq!(
            k.set(TrackerKind::Linear, "h", "  "),
            Err(TrackerError::EmptyKey)
        );
        assert_eq!(
            k.set(TrackerKind::Linear, "h", &"x".repeat(TOKEN_MAX + 1)),
            Err(TrackerError::TooLarge)
        );
        assert!(
            k.set(TrackerKind::Linear, "h", &"x".repeat(TOKEN_MAX))
                .is_ok()
        );
    }

    #[test]
    fn failing_store() {
        let k = MemoryKeys::new();
        k.set_fail(true);
        assert_eq!(
            k.get(TrackerKind::Linear, "h").err(),
            Some(TrackerError::SecretStore)
        );
        assert_eq!(
            k.set(TrackerKind::Linear, "h", "t"),
            Err(TrackerError::SecretStore)
        );
        assert_eq!(
            k.remove(TrackerKind::Linear).err(),
            Some(TrackerError::SecretStore)
        );
    }

    #[test]
    fn remove_reports_presence() {
        let k = MemoryKeys::new();
        k.set(TrackerKind::Jira, "h", "t").unwrap();
        assert_eq!(k.remove(TrackerKind::Jira), Ok(true));
        assert_eq!(k.remove(TrackerKind::Jira), Ok(false));
    }
}
