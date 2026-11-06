//! `license.json` in the app data dir: the last token, its certs and the latest time seen.
//! Written to a temp file then renamed. `last_seen_time` only moves forward.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cache {
    pub v: u8,
    /// The effective server base the token came from. A different server ignores the cache.
    pub server: String,
    pub token: Option<String>,
    pub certs: Vec<String>,
    pub last_seen_time: i64,
    /// Unix seconds of the last refresh the service answered, 0 if never.
    pub last_refresh_ok: i64,
}

impl Cache {
    pub fn new(server: &str) -> Cache {
        Cache {
            v: 1,
            server: server.to_owned(),
            token: None,
            certs: Vec::new(),
            last_seen_time: 0,
            last_refresh_ok: 0,
        }
    }
}

/// Never prints the token.
impl std::fmt::Debug for Cache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cache")
            .field("server", &self.server)
            .field("token", &self.token.as_ref().map(|_| "…"))
            .field("certs", &self.certs.len())
            .field("last_seen_time", &self.last_seen_time)
            .field("last_refresh_ok", &self.last_refresh_ok)
            .finish()
    }
}

/// A missing, unreadable or corrupt file, or an unknown version, is `None`.
pub fn read_cache(path: &Path) -> Option<Cache> {
    let raw = fs::read(path).ok()?;
    let c: Cache = serde_json::from_slice(&raw).ok()?;
    (c.v == 1).then_some(c)
}

/// Writes atomically. `last_seen_time` never goes below the value already on disk.
pub fn write_cache(path: &Path, cache: &Cache) -> std::io::Result<()> {
    let mut out = cache.clone();
    out.v = 1;
    if let Some(old) = read_cache(path) {
        out.last_seen_time = out.last_seen_time.max(old.last_seen_time);
    }
    let body = serde_json::to_vec_pretty(&out).map_err(std::io::Error::other)?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "license.json".to_owned());
    let tmp = dir.join(format!(".{name}.tmp"));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(last_seen: i64) -> Cache {
        Cache {
            token: Some("t.o.k".into()),
            certs: vec!["c.e.rt".into()],
            last_seen_time: last_seen,
            last_refresh_ok: 5,
            ..Cache::new("https://id.xdev.asia")
        }
    }

    #[test]
    fn cache_write_is_atomic_and_last_seen_monotonic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("license.json");
        assert!(read_cache(&path).is_none());
        write_cache(&path, &sample(100)).unwrap();
        assert_eq!(read_cache(&path).unwrap(), sample(100));
        // An older time does not move it back; a newer one moves it forward.
        write_cache(&path, &sample(50)).unwrap();
        assert_eq!(read_cache(&path).unwrap().last_seen_time, 100);
        write_cache(&path, &sample(200)).unwrap();
        assert_eq!(read_cache(&path).unwrap().last_seen_time, 200);
        // No temp file is left behind.
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["license.json".to_owned()]);
        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for key in [
            "v",
            "server",
            "token",
            "certs",
            "last_seen_time",
            "last_refresh_ok",
        ] {
            assert!(raw.get(key).is_some(), "{key}");
        }
    }

    #[test]
    fn corrupt_cache_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("license.json");
        fs::write(&path, b"{not json").unwrap();
        assert!(read_cache(&path).is_none());
        fs::write(&path, br#"{"v":2,"server":"x","token":null,"certs":[],"last_seen_time":0,"last_refresh_ok":0}"#).unwrap();
        assert!(read_cache(&path).is_none());
        // A corrupt file is replaced by the next write.
        write_cache(&path, &sample(7)).unwrap();
        assert_eq!(read_cache(&path).unwrap().last_seen_time, 7);
    }

    #[test]
    fn debug_never_prints_the_token() {
        let text = format!("{:?}", sample(1));
        assert!(!text.contains("t.o.k"));
        assert!(!text.contains("c.e.rt"));
    }
}
