//! Feature ids, declared once (D-R8). They mirror the cloud FEATURES list
//! (`tests/vectors/features.json`). Free code paths never ask the license; only code behind
//! one of these ids calls `license_allows`, from a file listed in `PRO_SURFACES.txt`.

use crate::grace::LicenseState;

/// Rc builds (the early-access channel). Client side only: the server never sends it; any
/// Pro feature in effect grants it.
pub const EARLY: &str = "pro.early";

/// The Pro ids the server sends.
pub(crate) const SERVER_PRO_FEATURES: &[&str] = &[
    "pro.phone",
    "pro.usage_history",
    "pro.session_replay",
    "pro.layouts",
];

pub const PRO_FEATURES: &[&str] = &[
    "pro.phone",
    "pro.usage_history",
    "pro.session_replay",
    "pro.layouts",
    EARLY,
];

/// Sync, push and Team: they need a token that has not expired. `sync.settings` is lane D's
/// id, not sent by the server yet.
pub const SUB_FEATURES: &[&str] = &[
    "sync.vault",
    "sync.history",
    "sync.settings",
    "push.phone",
    "team.workspace",
    "team.shared_settings",
    "team.roles",
];

pub fn is_known(feature: &str) -> bool {
    PRO_FEATURES.contains(&feature) || SUB_FEATURES.contains(&feature)
}

/// An unknown id is denied.
pub fn allows(state: &LicenseState, feature: &str) -> bool {
    if !is_known(feature) {
        return false;
    }
    match state {
        LicenseState::Free { .. } => false,
        LicenseState::Active { features, .. } => features.iter().any(|f| f == feature),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::grace::{DeviceInfo, Freshness};

    fn active(features: &[&str]) -> LicenseState {
        LicenseState::Active {
            plan: vec!["team".into()],
            features: features.iter().map(|f| (*f).to_owned()).collect(),
            freshness: Freshness::Fresh,
            pro: None,
            sync_until: None,
            team: None,
            device: DeviceInfo {
                fingerprint: "fp".into(),
                max: 0,
                active: 0,
            },
        }
    }

    #[test]
    fn unknown_id_is_denied() {
        let s = active(&["pro.phone", "pro.unknown"]);
        assert!(!allows(&s, "pro.unknown"));
        assert!(!allows(&s, ""));
        assert!(allows(&s, "pro.phone"));
        assert!(!allows(&LicenseState::free(None), "pro.phone"));
    }

    #[test]
    fn team_member_allows_pro_features() {
        // The server lists every Pro id for a Team seat; evaluate adds pro.early.
        let c = crate::claims::Claims {
            plan: vec!["team".into()],
            features: vec![
                "pro.layouts".into(),
                "pro.phone".into(),
                "pro.session_replay".into(),
                "pro.usage_history".into(),
                "team.roles".into(),
                "team.shared_settings".into(),
                "team.workspace".into(),
            ],
            pro: None,
            sync: None,
            team: Some(crate::claims::TeamClaim {
                org: "org".into(),
                role: "member".into(),
                seat: true,
            }),
            ..serde_json::from_value(crate::jws::tests::golden().claims).unwrap()
        };
        let s = crate::grace::evaluate(Some(&c), c.iat, 0, c.iat);
        for f in PRO_FEATURES {
            assert!(allows(&s, f), "{f}");
        }
        assert!(allows(&s, "team.workspace"));
        assert!(!allows(&s, "sync.vault"));
    }

    #[test]
    fn ids_match_cloud_features_json() {
        let raw = include_str!("../tests/vectors/features.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut cloud: Vec<&str> = Vec::new();
        for plan in ["pro", "sync", "team"] {
            for id in v[plan].as_array().unwrap() {
                cloud.push(id.as_str().unwrap());
            }
        }
        for id in &cloud {
            assert!(is_known(id), "cloud id {id} is not declared here");
        }
        let pro: Vec<&str> = v["pro"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(pro, SERVER_PRO_FEATURES);
        let client_only = ["pro.early", "sync.settings"];
        for id in PRO_FEATURES.iter().chain(SUB_FEATURES) {
            assert!(cloud.contains(id) || client_only.contains(id), "{id}");
        }
    }

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// `license_allows`, `xdev_license::allows`, or, in a file that uses `xdev_license`, a bare
    /// call `allows(` (not a method `.allows(` and not a `fn allows(` of its own).
    fn calls_the_gate(src: &str) -> bool {
        if src.contains("license_allows") || src.contains("xdev_license::allows") {
            return true;
        }
        if !src.contains("xdev_license") {
            return false;
        }
        src.match_indices("allows(").any(|(at, _)| {
            let before = &src[..at];
            let bare = !before
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.');
            bare && !before.trim_end().ends_with("fn")
        })
    }

    #[test]
    fn free_features_never_gated() {
        let root = repo_root();
        let listed: Vec<String> = include_str!("../PRO_SURFACES.txt")
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_owned)
            .collect();
        assert!(listed.contains(&"apps/desktop/src-tauri/src/license.rs".to_owned()));

        let mut files = Vec::new();
        rust_files(
            &root
                .join("apps")
                .join("desktop")
                .join("src-tauri")
                .join("src"),
            &mut files,
        );
        let crates = root.join("crates");
        for entry in fs::read_dir(&crates).unwrap().flatten() {
            if entry.file_name() != "xdev-license" {
                rust_files(&entry.path().join("src"), &mut files);
            }
        }
        assert!(files.len() > 10, "walked too few files: {}", files.len());

        let mut offenders = Vec::new();
        for path in files {
            let Ok(src) = fs::read_to_string(&path) else {
                continue;
            };
            if !calls_the_gate(&src) {
                continue;
            }
            let rel: Vec<String> = path
                .strip_prefix(&root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            let rel = rel.join("/");
            if !listed.contains(&rel) {
                offenders.push(rel);
            }
        }
        assert!(
            offenders.is_empty(),
            "the license gate is called from files not in PRO_SURFACES.txt: {offenders:?}"
        );
    }

    #[test]
    fn gate_detection() {
        assert!(calls_the_gate("if xdev_license::allows(&s, \"pro.phone\")"));
        assert!(calls_the_gate("invoke(\"license_allows\")"));
        assert!(calls_the_gate(
            "use xdev_license::{allows};
if allows(&s, f) {}"
        ));
        assert!(!calls_the_gate("fn disallows(x: u8)"));
        assert!(!calls_the_gate("if self.role.allows(min) {}"));
        assert!(!calls_the_gate(
            "use xdev_license::State;
pub fn allows(self) -> bool"
        ));
        assert!(!calls_the_gate("let x = 1;"));
    }
}
