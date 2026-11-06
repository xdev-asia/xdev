//! This computer's X25519 static key (M-R3): kept in the keychain under
//! `xdev` / `remote-host-key`, separate from the xDev ID device key.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use snow::resolvers::{CryptoResolver, DefaultResolver};

use crate::error::LinkError;

pub const KEYRING_SERVICE: &str = "xdev";
pub const KEYRING_USER: &str = "remote-host-key";

pub trait KeyStore: Send + Sync {
    /// `Ok(None)` when there is no key yet.
    fn load(&self) -> Result<Option<[u8; 32]>, LinkError>;
    fn save(&self, k: &[u8; 32]) -> Result<(), LinkError>;
}

/// The OS keychain. The private key is stored as standard base64.
pub struct KeyringStore;

fn entry() -> Result<keyring::Entry, LinkError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|_| LinkError::KeyStore)
}

impl KeyStore for KeyringStore {
    fn load(&self) -> Result<Option<[u8; 32]>, LinkError> {
        match entry()?.get_password() {
            Ok(raw) => Ok(decode_key(&raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(LinkError::KeyStore),
        }
    }

    fn save(&self, k: &[u8; 32]) -> Result<(), LinkError> {
        entry()?
            .set_password(&STANDARD.encode(k))
            .map_err(|_| LinkError::KeyStore)
    }
}

fn decode_key(raw: &str) -> Option<[u8; 32]> {
    STANDARD.decode(raw.trim()).ok()?.try_into().ok()
}

/// An in-memory store for tests, with a switch that makes every call fail.
#[derive(Default)]
pub struct MemoryStore {
    key: Mutex<Option<[u8; 32]>>,
    fail: AtomicBool,
}

impl MemoryStore {
    pub fn set_fail(&self, fail: bool) {
        self.fail.store(fail, Ordering::SeqCst);
    }
}

impl KeyStore for MemoryStore {
    fn load(&self) -> Result<Option<[u8; 32]>, LinkError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(LinkError::KeyStore);
        }
        Ok(*self.key.lock().map_err(|_| LinkError::KeyStore)?)
    }

    fn save(&self, k: &[u8; 32]) -> Result<(), LinkError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(LinkError::KeyStore);
        }
        *self.key.lock().map_err(|_| LinkError::KeyStore)? = Some(*k);
        Ok(())
    }
}

/// A static X25519 key pair. `Debug` never shows the private half.
#[derive(Clone)]
pub struct HostKey {
    private: [u8; 32],
    public: [u8; 32],
}

impl std::fmt::Debug for HostKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostKey")
            .field("host_id", &self.host_id())
            .finish_non_exhaustive()
    }
}

impl HostKey {
    /// The stored key, or a new one saved first. A failing store is an
    /// error, never a fresh key that would orphan every paired peer.
    pub fn load_or_create(store: &dyn KeyStore) -> Result<HostKey, LinkError> {
        if let Some(k) = store.load()? {
            return HostKey::from_private(k);
        }
        let key = HostKey::generate()?;
        store.save(&key.private)?;
        Ok(key)
    }

    pub fn generate() -> Result<HostKey, LinkError> {
        let mut private = [0u8; 32];
        getrandom::fill(&mut private).map_err(|_| LinkError::KeyStore)?;
        HostKey::from_private(private)
    }

    pub fn from_private(private: [u8; 32]) -> Result<HostKey, LinkError> {
        let mut dh = DefaultResolver
            .resolve_dh(&snow::params::DHChoice::Curve25519)
            .ok_or(LinkError::Handshake)?;
        dh.set(&private);
        let public: [u8; 32] = dh.pubkey().try_into().map_err(|_| LinkError::Handshake)?;
        Ok(HostKey { private, public })
    }

    pub fn public(&self) -> [u8; 32] {
        self.public
    }

    pub(crate) fn private(&self) -> &[u8; 32] {
        &self.private
    }

    /// b64url(sha256(pub)), first 16 characters.
    pub fn host_id(&self) -> String {
        host_id_of(&self.public)
    }

    /// The first 8 bytes of sha256(pub) as `XXXX-XXXX-XXXX-XXXX`.
    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.public)
    }
}

pub fn host_id_of(public: &[u8; 32]) -> String {
    let digest = Sha256::digest(public);
    let mut id = URL_SAFE_NO_PAD.encode(digest);
    id.truncate(16);
    id
}

pub fn fingerprint_of(public: &[u8; 32]) -> String {
    let digest = Sha256::digest(public);
    let hex: String = digest[..8].iter().map(|b| format!("{b:02X}")).collect();
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_once_then_reuse() {
        let store = MemoryStore::default();
        let a = HostKey::load_or_create(&store).unwrap();
        let b = HostKey::load_or_create(&store).unwrap();
        assert_eq!(a.public(), b.public());
    }

    #[test]
    fn failing_store_is_an_error_not_a_new_key() {
        let store = MemoryStore::default();
        store.set_fail(true);
        assert_eq!(
            HostKey::load_or_create(&store).unwrap_err(),
            LinkError::KeyStore
        );
    }

    #[test]
    fn host_id_and_fingerprint_shape() {
        let key = HostKey::from_private([7u8; 32]).unwrap();
        assert_eq!(key.host_id().len(), 16);
        let fp = key.fingerprint();
        assert_eq!(fp.len(), 19);
        assert_eq!(fp.split('-').count(), 4);
        assert!(fp.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
    }

    #[test]
    fn debug_hides_private_key() {
        let key = HostKey::from_private([7u8; 32]).unwrap();
        let shown = format!("{key:?}");
        assert!(!shown.contains("private"));
        assert!(shown.contains(&key.host_id()));
    }
}
