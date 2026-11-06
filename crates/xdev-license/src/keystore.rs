//! The device key (D-R6): an Ed25519 key that proves the device and an X25519 key for Sync,
//! kept as one OS keychain entry `{"v":1,"ed":…,"x":…}` (service `xdev`, user `device-key`).
//! No file fallback: without a keychain the license is Free with `license_keychain`.

use std::fmt;

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{E_KEYCHAIN, KEYRING_USER, b64};

/// Signed when a device registers.
pub const DEVICE_PROOF: &str = "xdev-device-v1";
/// Signed when a device asks for a token.
pub const ENT_PROOF: &str = "xdev-ent-v1";

/// `purpose \n nonce \n uid`, the bytes the service checks.
pub fn proof_message(purpose: &str, nonce: &str, uid: &str) -> String {
    format!("{purpose}\n{nonce}\n{uid}")
}

/// The keychain could not be read or written. The cause is dropped: it may name the entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("license_keychain")]
pub struct StoreError;

impl StoreError {
    pub fn code(self) -> &'static str {
        E_KEYCHAIN
    }
}

#[derive(Clone)]
pub struct DeviceKey {
    ed: SigningKey,
    x: StaticSecret,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    v: u8,
    ed: String,
    x: String,
}

impl DeviceKey {
    pub fn generate() -> Result<DeviceKey, getrandom::Error> {
        let mut ed = [0u8; 32];
        let mut x = [0u8; 32];
        getrandom::fill(&mut ed)?;
        getrandom::fill(&mut x)?;
        Ok(DeviceKey::from_seeds(ed, x))
    }

    pub fn from_seeds(ed: [u8; 32], x: [u8; 32]) -> DeviceKey {
        DeviceKey {
            ed: SigningKey::from_bytes(&ed),
            x: StaticSecret::from(x),
        }
    }

    pub fn public(&self) -> [u8; 32] {
        self.ed.verifying_key().to_bytes()
    }

    /// `b64url(sha256(pub))[0..22]`, as the service computes it.
    pub fn fingerprint(&self) -> String {
        let mut fp = b64::encode(&Sha256::digest(self.public()));
        fp.truncate(22);
        fp
    }

    pub fn public_b64(&self) -> String {
        b64::encode(&self.public())
    }

    pub fn box_public_b64(&self) -> String {
        b64::encode(PublicKey::from(&self.x).as_bytes())
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.ed.sign(msg).to_bytes()
    }

    /// The keychain JSON. Holds both private keys: never log it.
    fn to_json(&self) -> String {
        serde_json::to_string(&Stored {
            v: 1,
            ed: b64::encode(&self.ed.to_bytes()),
            x: b64::encode(&self.x.to_bytes()),
        })
        .unwrap_or_default()
    }

    /// `None` for any shape error or an unknown version.
    fn from_json(raw: &str) -> Option<DeviceKey> {
        let s: Stored = serde_json::from_str(raw).ok()?;
        if s.v != 1 {
            return None;
        }
        Some(DeviceKey::from_seeds(
            b64::decode_32(&s.ed)?,
            b64::decode_32(&s.x)?,
        ))
    }
}

impl fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceKey")
            .field("fingerprint", &self.fingerprint())
            .finish_non_exhaustive()
    }
}

pub trait KeyStore: Send + Sync {
    /// No entry, or an entry that does not decode, is `Ok(None)`.
    fn load(&self) -> Result<Option<DeviceKey>, StoreError>;
    fn save(&self, k: &DeviceKey) -> Result<(), StoreError>;
}

/// The OS keychain.
pub struct KeychainKeys;

fn entry() -> Result<keyring::Entry, StoreError> {
    keyring::Entry::new(xdev_id::KEYRING_SERVICE, KEYRING_USER).map_err(|_| StoreError)
}

impl KeyStore for KeychainKeys {
    fn load(&self) -> Result<Option<DeviceKey>, StoreError> {
        match entry()?.get_password() {
            Ok(raw) => Ok(DeviceKey::from_json(&raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(StoreError),
        }
    }

    fn save(&self, k: &DeviceKey) -> Result<(), StoreError> {
        entry()?.set_password(&k.to_json()).map_err(|_| StoreError)
    }
}

/// In memory, for tests, with a switch that makes every call fail. Lane D's `MemoryKeys`.
#[cfg(any(test, feature = "test-util"))]
#[derive(Default)]
pub struct MemoryKeys {
    raw: std::sync::Mutex<Option<String>>,
    fail: std::sync::atomic::AtomicBool,
}

#[cfg(any(test, feature = "test-util"))]
impl MemoryKeys {
    pub fn set_fail(&self, fail: bool) {
        self.fail.store(fail, std::sync::atomic::Ordering::SeqCst);
    }

    fn check(&self) -> Result<(), StoreError> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            Err(StoreError)
        } else {
            Ok(())
        }
    }
}

/// The brief's name for the in-memory store.
#[cfg(any(test, feature = "test-util"))]
pub type MemoryKeystore = MemoryKeys;

#[cfg(any(test, feature = "test-util"))]
impl KeyStore for MemoryKeys {
    fn load(&self) -> Result<Option<DeviceKey>, StoreError> {
        self.check()?;
        let raw = self.raw.lock().map_err(|_| StoreError)?;
        Ok(raw.as_deref().and_then(DeviceKey::from_json))
    }

    fn save(&self, k: &DeviceKey) -> Result<(), StoreError> {
        self.check()?;
        *self.raw.lock().map_err(|_| StoreError)? = Some(k.to_json());
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signature, VerifyingKey};

    pub(crate) fn public_of(seed: &[u8; 32]) -> [u8; 32] {
        SigningKey::from_bytes(seed).verifying_key().to_bytes()
    }

    fn key() -> DeviceKey {
        DeviceKey::from_seeds([1u8; 32], [2u8; 32])
    }

    #[test]
    fn fingerprint_is_b64url_sha256_first_22() {
        let k = key();
        let full = b64::encode(&Sha256::digest(public_of(&[1u8; 32])));
        assert_eq!(k.fingerprint(), full[..22]);
        assert_eq!(k.fingerprint().len(), 22);
    }

    #[test]
    fn round_trip_through_memory_store() {
        let store = MemoryKeys::default();
        assert!(store.load().unwrap().is_none());
        let k = DeviceKey::generate().unwrap();
        store.save(&k).unwrap();
        let back = store.load().unwrap().unwrap();
        assert_eq!(back.public(), k.public());
        assert_eq!(back.box_public_b64(), k.box_public_b64());
        let raw = store.raw.lock().unwrap().clone().unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(b64::decode(v["ed"].as_str().unwrap()).unwrap().len(), 32);
        assert_eq!(b64::decode(v["x"].as_str().unwrap()).unwrap().len(), 32);
    }

    #[test]
    fn debug_never_prints_seed() {
        let k = key();
        let text = format!("{k:?}");
        assert!(text.contains(&k.fingerprint()));
        assert!(!text.contains(&b64::encode(&[1u8; 32])));
        assert!(!text.contains(&b64::encode(&[2u8; 32])));
        assert!(!text.contains("[1, 1"));
    }

    #[test]
    fn proof_message_format_is_xdev_device_v1_nonce_uid() {
        let nonce = "n".repeat(43);
        let msg = proof_message(DEVICE_PROOF, &nonce, "user-1");
        assert_eq!(
            msg.as_bytes(),
            format!("xdev-device-v1\n{nonce}\nuser-1").as_bytes()
        );
        assert_eq!(proof_message(ENT_PROOF, "a", "b"), "xdev-ent-v1\na\nb");
        let k = key();
        let sig = k.sign(msg.as_bytes());
        let vk = VerifyingKey::from_bytes(&k.public()).unwrap();
        vk.verify_strict(msg.as_bytes(), &Signature::from_bytes(&sig))
            .unwrap();
    }

    #[test]
    fn failing_store_yields_keychain_error() {
        let store = MemoryKeys::default();
        store.set_fail(true);
        let err = store.load().unwrap_err();
        assert_eq!(err.code(), "license_keychain");
        assert_eq!(store.save(&key()).unwrap_err().code(), E_KEYCHAIN);
    }

    #[test]
    fn bad_keychain_entry_reads_as_none() {
        assert!(DeviceKey::from_json("{}").is_none());
        assert!(DeviceKey::from_json(r#"{"v":2,"ed":"","x":""}"#).is_none());
        assert!(DeviceKey::from_json("not json").is_none());
    }
}
