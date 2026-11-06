//! Which server the license talks to, and which roots its tokens are trusted under (D-R4,
//! D-R5). `cloud.serverUrl` in settings is the single source; `XDEV_ID_URL` wins in
//! development. TODO(D8): the desktop glue reads the xDev ID base from `effective_base`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{E_SERVER_KEY, b64};

pub use xdev_id::DEFAULT_BASE as DEFAULT_SERVER;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfig {
    pub server_url: String,
    /// base64url raw 32-byte Ed25519 root keys; used only for a custom server.
    pub pinned_roots: Vec<String>,
}

impl Default for CloudConfig {
    fn default() -> CloudConfig {
        CloudConfig {
            server_url: DEFAULT_SERVER.to_owned(),
            pinned_roots: Vec::new(),
        }
    }
}

/// Env override, then the setting, then the default. Only https, or http to a loopback host;
/// anything else falls through to the next source. No trailing slash.
pub fn effective_base(cfg: &CloudConfig, env_override: Option<&str>) -> String {
    env_override
        .and_then(xdev_id::check_origin)
        .or_else(|| xdev_id::check_origin(&cfg.server_url))
        .unwrap_or_else(|| DEFAULT_SERVER.to_owned())
}

/// True when the setting names the official server (or nothing usable).
pub fn is_default_server(cfg: &CloudConfig) -> bool {
    xdev_id::check_origin(&cfg.server_url).is_none_or(|o| o == DEFAULT_SERVER)
}

/// The default server uses only `builtin` and ignores `pinned_roots`; a custom server uses
/// only `pinned_roots`, and needs at least one. A bad entry is an error, not skipped.
pub fn effective_roots(
    cfg: &CloudConfig,
    builtin: &[[u8; 32]],
) -> Result<Vec<[u8; 32]>, &'static str> {
    if is_default_server(cfg) {
        return Ok(builtin.to_vec());
    }
    if cfg.pinned_roots.is_empty() {
        return Err(E_SERVER_KEY);
    }
    cfg.pinned_roots
        .iter()
        .map(|r| b64::decode_32(r.trim()).ok_or(E_SERVER_KEY))
        .collect()
}

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// `XXXX-XXXX-XXXX-XXXX`: the first 16 base32 characters of sha256(key), for reading aloud.
pub fn root_fingerprint(pub32: &[u8; 32]) -> String {
    let digest = Sha256::digest(pub32);
    // 16 characters x 5 bits = 80 bits = the first 10 bytes.
    let mut bits: u128 = 0;
    for byte in &digest[..10] {
        bits = (bits << 8) | u128::from(*byte);
    }
    let mut out = String::with_capacity(19);
    for i in 0..16 {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        let shift = 75 - 5 * i;
        out.push(char::from(B32[((bits >> shift) & 0x1f) as usize]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILTIN: [[u8; 32]; 1] = [[1u8; 32]];

    fn custom(roots: &[[u8; 32]]) -> CloudConfig {
        CloudConfig {
            server_url: "https://license.example.test".to_owned(),
            pinned_roots: roots.iter().map(|r| b64::encode(r)).collect(),
        }
    }

    #[test]
    fn default_server_uses_builtin_roots() {
        let cfg = CloudConfig::default();
        assert_eq!(effective_roots(&cfg, &BUILTIN).unwrap(), BUILTIN.to_vec());
    }

    #[test]
    fn custom_server_ignores_builtin_roots() {
        let cfg = custom(&[[2u8; 32]]);
        assert_eq!(effective_roots(&cfg, &BUILTIN).unwrap(), vec![[2u8; 32]]);
    }

    #[test]
    fn custom_server_without_pinned_root_is_an_error() {
        let cfg = custom(&[]);
        assert_eq!(effective_roots(&cfg, &BUILTIN).unwrap_err(), E_SERVER_KEY);
        let mut bad = custom(&[]);
        bad.pinned_roots.push("not-a-key".to_owned());
        assert_eq!(effective_roots(&bad, &BUILTIN).unwrap_err(), E_SERVER_KEY);
    }

    #[test]
    fn default_server_ignores_pinned_roots() {
        let mut cfg = custom(&[[2u8; 32]]);
        cfg.server_url = "https://id.xdev.asia/".to_owned();
        assert_eq!(effective_roots(&cfg, &BUILTIN).unwrap(), BUILTIN.to_vec());
    }

    #[test]
    fn rejects_http_to_a_public_host() {
        let cfg = CloudConfig {
            server_url: "http://license.example.test".to_owned(),
            pinned_roots: Vec::new(),
        };
        assert_eq!(effective_base(&cfg, None), DEFAULT_SERVER);
        assert_eq!(
            effective_base(&CloudConfig::default(), Some("http://evil.test")),
            DEFAULT_SERVER
        );
    }

    #[test]
    fn allows_http_localhost() {
        let cfg = CloudConfig {
            server_url: "http://localhost:8787/".to_owned(),
            pinned_roots: Vec::new(),
        };
        assert_eq!(effective_base(&cfg, None), "http://localhost:8787");
        assert_eq!(
            effective_base(&CloudConfig::default(), Some("http://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
    }

    #[test]
    fn env_override_wins() {
        let cfg = custom(&[]);
        assert_eq!(
            effective_base(&cfg, Some("https://dev.example.test/")),
            "https://dev.example.test"
        );
        assert_eq!(effective_base(&cfg, None), "https://license.example.test");
    }

    #[test]
    fn fingerprint_is_19_chars_grouped_by_4() {
        let fp = root_fingerprint(&[7u8; 32]);
        assert_eq!(fp.len(), 19);
        let groups: Vec<&str> = fp.split('-').collect();
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|g| g.len() == 4));
        assert!(fp.chars().all(|c| c == '-' || B32.contains(&(c as u8))));
        assert_ne!(fp, root_fingerprint(&[8u8; 32]));
    }

    #[test]
    fn fingerprint_matches_base32_of_sha256() {
        // sha256 of 32 zero bytes starts 66 68 7a ad f8 62 bd 77 6c 8f; base32 of those
        // 10 bytes is MZUH VLPY MK6X O3EP.
        assert_eq!(root_fingerprint(&[0u8; 32]), "MZUH-VLPY-MK6X-O3EP");
    }
}
