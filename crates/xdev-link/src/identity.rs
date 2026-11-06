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

/// The `LinkError::Io` detail of a key file that others may read (Unix).
pub const KEY_PERMS: &str = "key_perms";

/// A key in a file of its own: 32 raw bytes, for a headless host where the
/// OS keychain may be missing. On Unix the folder is 0700 and the file 0600,
/// and a file with group or other bits is refused. On Windows the per-user
/// data folder's own ACL is what keeps it private.
pub struct FileKeyStore {
    path: std::path::PathBuf,
}

impl FileKeyStore {
    pub fn new(path: impl Into<std::path::PathBuf>) -> FileKeyStore {
        FileKeyStore { path: path.into() }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    fn dir(&self) -> Result<&std::path::Path, LinkError> {
        self.path.parent().ok_or(LinkError::KeyStore)
    }
}

impl KeyStore for FileKeyStore {
    fn load(&self) -> Result<Option<[u8; 32]>, LinkError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&self.path)?.permissions().mode();
            if mode & 0o077 != 0 {
                return Err(LinkError::Io(KEY_PERMS.into()));
            }
        }
        let key: [u8; 32] = bytes.try_into().map_err(|_| LinkError::KeyStore)?;
        Ok(Some(key))
    }

    fn save(&self, k: &[u8; 32]) -> Result<(), LinkError> {
        use std::io::Write;
        let dir = self.dir()?;
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut name = self.path.file_name().ok_or(LinkError::KeyStore)?.to_owned();
        name.push(format!(".tmp-{}", std::process::id()));
        let tmp = dir.join(name);
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let written = (|| {
            let mut f = opts.open(&tmp)?;
            f.write_all(k)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&tmp, &self.path)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(written?)
    }
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
    fn file_store_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileKeyStore::new(dir.path().join("serve/host-key"));
        assert_eq!(store.load().unwrap(), None);
        store.save(&[5; 32]).unwrap();
        assert_eq!(store.load().unwrap(), Some([5; 32]));
        let a = HostKey::load_or_create(&FileKeyStore::new(dir.path().join("serve/k2"))).unwrap();
        let b = HostKey::load_or_create(&FileKeyStore::new(dir.path().join("serve/k2"))).unwrap();
        assert_eq!(a.host_id(), b.host_id());
        // The temp file is gone after the rename.
        let names: Vec<_> = std::fs::read_dir(dir.path().join("serve"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn file_store_wrong_length_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host-key");
        std::fs::write(&path, [1u8; 31]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            FileKeyStore::new(&path).load().unwrap_err(),
            LinkError::KeyStore
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_store_modes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("serve/host-key");
        let store = FileKeyStore::new(&path);
        store.save(&[3; 32]).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir.path().join("serve")), 0o700);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(store.load().unwrap_err(), LinkError::Io(KEY_PERMS.into()));
    }

    #[test]
    fn debug_hides_private_key() {
        let key = HostKey::from_private([7u8; 32]).unwrap();
        let shown = format!("{key:?}");
        assert!(!shown.contains("private"));
        assert!(shown.contains(&key.host_id()));
    }
}
