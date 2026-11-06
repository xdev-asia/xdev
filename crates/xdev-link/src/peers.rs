//! `peers.json`: the phones and computers paired with this one.
//!
//! `{v:1, peers:[{id, name, kind, static_pub, role, addrs, created_at,
//! last_seen_at}]}`. Lane M's `scope` reads as a role. Writes go to a temp
//! file and are renamed over the old one; a file that does not parse is kept
//! as `peers.json.bad` and replaced by an empty store.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::error::LinkError;
use crate::identity::host_id_of;
use crate::types::{PeerKind, PeerRole};

const VERSION: u32 = 1;
/// Stored addresses per peer, newest first.
const ADDRS_MAX: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredPeer {
    pub id: String,
    pub name: String,
    pub kind: PeerKind,
    /// Standard base64 of the X25519 public key.
    pub static_pub: String,
    pub role: PeerRole,
    pub addrs: Vec<String>,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
}

impl StoredPeer {
    pub fn new(name: &str, kind: PeerKind, public: &[u8; 32], now_ms: u64) -> StoredPeer {
        StoredPeer {
            id: host_id_of(public),
            name: name.to_owned(),
            kind,
            static_pub: STANDARD.encode(public),
            role: PeerRole::None,
            addrs: Vec::new(),
            created_at: now_ms,
            last_seen_at: None,
        }
    }

    pub fn public(&self) -> Option<[u8; 32]> {
        STANDARD.decode(&self.static_pub).ok()?.try_into().ok()
    }
}

/// Reads both this crate's `role` and lane M's `scope`.
#[derive(Deserialize)]
struct RawPeer {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default = "phone")]
    kind: PeerKind,
    static_pub: String,
    #[serde(default)]
    role: Option<PeerRole>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    addrs: Vec<String>,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    last_seen_at: Option<u64>,
}

/// A record without `kind` was written by lane M, which pairs only phones.
fn phone() -> PeerKind {
    PeerKind::Phone
}

impl RawPeer {
    fn into_peer(self) -> Option<StoredPeer> {
        let public: [u8; 32] = STANDARD.decode(&self.static_pub).ok()?.try_into().ok()?;
        let role = self
            .role
            .or_else(|| self.scope.as_deref().map(PeerRole::from_scope))
            .unwrap_or_default();
        Some(StoredPeer {
            id: self.id.unwrap_or_else(|| host_id_of(&public)),
            name: self.name,
            kind: self.kind,
            static_pub: self.static_pub,
            role,
            addrs: self.addrs,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
        })
    }
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    peers: Vec<RawPeer>,
}

#[derive(Serialize)]
struct FileOut<'a> {
    v: u32,
    peers: &'a [StoredPeer],
}

pub struct PeerStore {
    path: PathBuf,
    peers: Mutex<Vec<StoredPeer>>,
}

impl std::fmt::Debug for PeerStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerStore")
            .field("path", &self.path)
            .finish()
    }
}

fn store_err(e: impl std::fmt::Display) -> LinkError {
    LinkError::Store(e.to_string())
}

impl PeerStore {
    /// Loads `path`, or starts empty when it is missing. A file that does not
    /// parse is moved to `<path>.bad`.
    pub fn open(path: &Path) -> Result<PeerStore, LinkError> {
        let peers = match fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<RawFile>(&bytes) {
                Ok(raw) => raw
                    .peers
                    .into_iter()
                    .filter_map(RawPeer::into_peer)
                    .collect(),
                Err(_) => {
                    let mut bad = path.as_os_str().to_owned();
                    bad.push(".bad");
                    fs::rename(path, PathBuf::from(bad)).map_err(store_err)?;
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(store_err(e)),
        };
        let store = PeerStore {
            path: path.to_owned(),
            peers: Mutex::new(peers),
        };
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Vec<StoredPeer>>, LinkError> {
        self.peers.lock().map_err(|_| store_err("poisoned"))
    }

    fn write(&self, peers: &[StoredPeer]) -> Result<(), LinkError> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(store_err)?;
        }
        let body = serde_json::to_vec_pretty(&FileOut { v: VERSION, peers }).map_err(store_err)?;
        let mut tmp = self.path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, body).map_err(store_err)?;
        fs::rename(&tmp, &self.path).map_err(store_err)
    }

    fn update<T>(
        &self,
        f: impl FnOnce(&mut Vec<StoredPeer>) -> Result<T, LinkError>,
    ) -> Result<T, LinkError> {
        let mut peers = self.lock()?;
        let mut next = peers.clone();
        let out = f(&mut next)?;
        self.write(&next)?;
        *peers = next;
        Ok(out)
    }

    pub fn list(&self) -> Vec<StoredPeer> {
        self.lock().map(|p| p.clone()).unwrap_or_default()
    }

    /// Adds a peer, or replaces the one with the same key.
    pub fn add(&self, peer: StoredPeer) -> Result<StoredPeer, LinkError> {
        self.update(|peers| {
            peers.retain(|p| p.static_pub != peer.static_pub && p.id != peer.id);
            peers.push(peer.clone());
            Ok(peer)
        })
    }

    pub fn find_by_pub(&self, public: &[u8; 32]) -> Option<StoredPeer> {
        let b64 = STANDARD.encode(public);
        self.lock()
            .ok()?
            .iter()
            .find(|p| p.static_pub == b64)
            .cloned()
    }

    pub fn find_by_id(&self, id: &str) -> Option<StoredPeer> {
        self.lock().ok()?.iter().find(|p| p.id == id).cloned()
    }

    fn edit(&self, id: &str, f: impl FnOnce(&mut StoredPeer)) -> Result<StoredPeer, LinkError> {
        self.update(|peers| {
            let p = peers
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| store_err("no such peer"))?;
            f(p);
            Ok(p.clone())
        })
    }

    pub fn set_role(&self, id: &str, role: PeerRole) -> Result<StoredPeer, LinkError> {
        self.edit(id, |p| p.role = role)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<StoredPeer, LinkError> {
        let name = name.trim().to_owned();
        self.edit(id, |p| p.name = name)
    }

    /// `Ok(false)` when there was no such peer.
    pub fn remove(&self, id: &str) -> Result<bool, LinkError> {
        self.update(|peers| {
            let before = peers.len();
            peers.retain(|p| p.id != id);
            Ok(peers.len() != before)
        })
    }

    /// Records a connection: `last_seen_at`, and `addr` first in `addrs`.
    pub fn touch(
        &self,
        id: &str,
        addr: Option<&str>,
        now_ms: u64,
    ) -> Result<StoredPeer, LinkError> {
        self.edit(id, |p| {
            p.last_seen_at = Some(now_ms);
            if let Some(addr) = addr {
                p.addrs.retain(|a| a != addr);
                p.addrs.insert(0, addr.to_owned());
                p.addrs.truncate(ADDRS_MAX);
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> [u8; 32] {
        crate::identity::HostKey::from_private([n; 32])
            .unwrap()
            .public()
    }

    #[test]
    fn add_find_role_rename_remove() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peers.json");
        let store = PeerStore::open(&path).unwrap();
        let p = store
            .add(StoredPeer::new("studio-mac", PeerKind::Desktop, &key(1), 5))
            .unwrap();
        assert_eq!(p.role, PeerRole::None);
        assert_eq!(store.find_by_pub(&key(1)).unwrap().id, p.id);
        assert!(store.find_by_pub(&key(2)).is_none());

        store.set_role(&p.id, PeerRole::Operator).unwrap();
        store.rename(&p.id, " studio ").unwrap();
        store.touch(&p.id, Some("10.0.0.2:47821"), 9).unwrap();

        let again = PeerStore::open(&path).unwrap();
        let q = again.find_by_id(&p.id).unwrap();
        assert_eq!(q.role, PeerRole::Operator);
        assert_eq!(q.name, "studio");
        assert_eq!(q.addrs, ["10.0.0.2:47821"]);
        assert_eq!(q.last_seen_at, Some(9));
        assert_eq!(q.public(), Some(key(1)));

        assert!(again.remove(&p.id).unwrap());
        assert!(!again.remove(&p.id).unwrap());
        assert!(again.set_role(&p.id, PeerRole::Admin).is_err());
    }

    #[test]
    fn reads_lane_m_scope_as_role() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peers.json");
        let k1 = STANDARD.encode(key(1));
        let k2 = STANDARD.encode(key(2));
        fs::write(
            &path,
            format!(
                r#"{{"v":1,"peers":[
                {{"id":"a","name":"phone","static_pub":"{k1}","scope":"read","created_at":1}},
                {{"id":"b","name":"tab","static_pub":"{k2}","scope":"control","created_at":2}}
            ]}}"#
            ),
        )
        .unwrap();
        let store = PeerStore::open(&path).unwrap();
        let a = store.find_by_id("a").unwrap();
        assert_eq!(a.role, PeerRole::Viewer);
        assert_eq!(a.kind, PeerKind::Phone);
        assert_eq!(store.find_by_id("b").unwrap().role, PeerRole::Operator);

        // The next write uses `role`, not `scope`.
        store.set_role("a", PeerRole::Viewer).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"role\": \"viewer\""));
        assert!(!text.contains("scope"));
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peers.json");
        fs::write(&path, b"{not json").unwrap();
        let store = PeerStore::open(&path).unwrap();
        assert!(store.list().is_empty());
        assert!(dir.path().join("peers.json.bad").exists());
        assert!(!path.exists());
        store
            .add(StoredPeer::new("x", PeerKind::Phone, &key(3), 0))
            .unwrap();
        assert_eq!(PeerStore::open(&path).unwrap().list().len(), 1);
        assert!(!dir.path().join("peers.json.tmp").exists());
    }

    #[test]
    fn same_key_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let store = PeerStore::open(&dir.path().join("peers.json")).unwrap();
        store
            .add(StoredPeer::new("old", PeerKind::Desktop, &key(4), 0))
            .unwrap();
        store
            .add(StoredPeer::new("new", PeerKind::Desktop, &key(4), 1))
            .unwrap();
        let all = store.list();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "new");
    }

    #[test]
    fn touch_caps_addresses() {
        let dir = tempfile::tempdir().unwrap();
        let store = PeerStore::open(&dir.path().join("peers.json")).unwrap();
        let p = store
            .add(StoredPeer::new("p", PeerKind::Desktop, &key(5), 0))
            .unwrap();
        for i in 0..6 {
            store
                .touch(&p.id, Some(&format!("10.0.0.{i}:1")), i)
                .unwrap();
        }
        store.touch(&p.id, Some("10.0.0.3:1"), 9).unwrap();
        let q = store.find_by_id(&p.id).unwrap();
        assert_eq!(
            q.addrs,
            ["10.0.0.3:1", "10.0.0.5:1", "10.0.0.4:1", "10.0.0.2:1"]
        );
    }
}
