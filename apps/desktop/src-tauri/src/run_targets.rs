//! The Run targets menu's data: a worktree's deploy presets (detected and
//! from `xdev.toml`) and its `[vps]` target. Presets run as a visible
//! command in a terminal tab typed by the UI; nothing runs here.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_workspace::deploy::{self, DeployPreset, VpsTarget};
use xdev_workspace::{Registry, WorkspaceError};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{WorkspaceLock, clock, lock_guard};

/// What the menu shows for a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TargetsView {
    /// Detected presets first, then the repo's. A repo preset is not run
    /// while `trusted` is false.
    pub deploy: Vec<DeployPreset>,
    pub vps: Option<VpsTarget>,
    /// The repo's parts are trusted, or it has none.
    pub trusted: bool,
    /// Blake3 hex to pass to `targets_trust`; empty when there is nothing to trust.
    pub hash: String,
    /// The text of `xdev.toml`, for the trust dialog.
    pub text: Option<String>,
    /// Why `xdev.toml` was not used.
    pub error: Option<String>,
    /// `vps.host` is in xDev's SSH hosts or `~/.ssh/config`; true without a `[vps]`.
    pub vps_host_known: bool,
}

/// True when `host` is not a saved alias and not a `Host` alias of the config text.
fn vps_host_unknown(saved: &[xdev_ssh::SshHost], config: Option<&str>, host: &str) -> bool {
    if saved.iter().any(|h| h.alias == host) {
        return false;
    }
    let in_config = config
        .map(|text| xdev_ssh::parse_config(text).hosts)
        .is_some_and(|hosts| hosts.iter().any(|h| h.alias == host));
    !in_config
}

fn view_of(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
    on_path: impl Fn(&str) -> bool,
    config: Option<&str>,
) -> Result<TargetsView, CmdError> {
    let repo = deploy::repo_targets(reg, data, worktree)?;
    let detected = deploy::detect(worktree, on_path);
    let saved = xdev_ssh::load(data).unwrap_or_default();
    let vps_host_known = repo
        .vps
        .as_ref()
        .is_none_or(|v| !vps_host_unknown(&saved, config, &v.host));
    Ok(TargetsView {
        deploy: deploy::merge(detected, repo.deploy),
        vps: repo.vps,
        trusted: repo.trusted,
        hash: repo.hash,
        text: repo.text,
        error: repo.error,
        vps_host_known,
    })
}

fn ssh_config_text() -> Option<String> {
    let path = crate::applog::home_dir()?.join(".ssh").join("config");
    std::fs::read_to_string(path).ok()
}

/// The worktree's deploy presets and `[vps]` target.
#[tauri::command(async)]
pub fn targets_list(
    state: State<'_, AppState>,
    worktree: PathBuf,
) -> Result<TargetsView, CmdError> {
    let data = data_dir(&state)?;
    let reg = Registry::load(data)?;
    view_of(
        &reg,
        data,
        &worktree,
        |p| xdev_agent::find_program(p).is_some(),
        ssh_config_text().as_deref(),
    )
}

/// Trusts the repo's current `[[deploy]]` and `[vps]`; `deploy_untrusted`
/// when `hash` is not theirs (the file changed).
#[tauri::command(async)]
pub fn targets_trust(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    worktree: PathBuf,
    hash: String,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let (now_ms, _) = clock();
    let _guard = lock_guard(&lock);
    let reg = Registry::load(data)?;
    deploy::trust_targets(&reg, data, &worktree, &hash, now_ms).map_err(|e| match e {
        WorkspaceError::HookUntrusted(_) => CmdError {
            code: "deploy_untrusted",
            detail: Some(e.to_string()),
        },
        other => other.into(),
    })
}

/// The `[vps] notes` path, repo-relative, when it is a file under the worktree.
fn notes_in(vps: Option<&VpsTarget>, worktree: &Path) -> Option<String> {
    let notes = vps?.notes.as_deref()?;
    // `validate` already refused `..` and rooted paths; the check below also
    // catches a link that leaves the worktree.
    let mut full = worktree.to_path_buf();
    for part in notes.split('/').filter(|p| !p.is_empty() && *p != ".") {
        full.push(part);
    }
    let real = full.canonicalize().ok()?;
    let root = worktree.canonicalize().ok()?;
    (real.starts_with(&root) && real.is_file()).then(|| notes.to_owned())
}

/// The `[vps] notes` path when that file exists under the worktree.
#[tauri::command(async)]
pub fn targets_vps_notes(
    state: State<'_, AppState>,
    worktree: PathBuf,
) -> Result<Option<String>, CmdError> {
    let data = data_dir(&state)?;
    let reg = Registry::load(data)?;
    let repo = deploy::repo_targets(&reg, data, &worktree)?;
    Ok(notes_in(repo.vps.as_ref(), &worktree))
}

// --- simulators (run-targets-mobile) ---

fn sdk_list(sdk: &crate::mobile::Sdk<'_>, ios: bool) -> crate::mobile::SimList {
    crate::mobile::list_all(ios, sdk, &|p, a, t| crate::agent_path::capture(p, a, t))
}

/// Runs `f` with the real environment's SDK search.
fn with_sdk<R>(f: impl FnOnce(&crate::mobile::Sdk<'_>) -> R) -> R {
    let find = |p: &str| xdev_agent::find_program(p);
    let var = |k: &str| std::env::var(k).ok();
    let is_file = |p: &Path| p.is_file();
    f(&crate::mobile::Sdk {
        find_program: &find,
        var: &var,
        is_file: &is_file,
        home: crate::applog::home_dir(),
    })
}

/// The installed iOS simulators (macOS) and Android AVDs.
#[tauri::command(async)]
pub fn sims_list() -> Result<crate::mobile::SimList, CmdError> {
    Ok(with_sdk(|sdk| sdk_list(sdk, cfg!(target_os = "macos"))))
}

/// Boots a simulator (iOS) and returns the commands to type into tabs. The
/// id must be in a fresh list, so no other string reaches a command.
#[tauri::command(async)]
pub fn sim_boot(device: crate::mobile::SimRef) -> Result<crate::mobile::SimLaunch, CmdError> {
    use crate::mobile::{self, SimPlatform};
    let ios = cfg!(target_os = "macos");
    if device.platform == SimPlatform::Ios && !ios {
        return Err(CmdError {
            code: "sim_unsupported",
            detail: None,
        });
    }
    with_sdk(|sdk| {
        let list = sdk_list(sdk, ios);
        let found = mobile::find_device(&list, &device)?;
        if found.platform == SimPlatform::Ios {
            mobile::boot_ios(&found.id, &|p, a, t| crate::agent_path::capture(p, a, t));
        }
        let emulator = sdk.find("emulator", "emulator");
        let adb = sdk.find("adb", "platform-tools");
        mobile::sim_launch(
            &found,
            emulator.as_deref(),
            adb.as_deref(),
            mobile::Shell::host(),
            // The tab title is translated in the UI; this is only a fallback.
            &|name| name.to_owned(),
        )
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use xdev_workspace::{RepoEntry, WorktreeMeta};

    use super::*;

    const TOML: &str = "[[deploy]]\nname = \"Staging\"\nrun = \"make stage\"\n\n[vps]\nhost = \"prod-1\"\nnotes = \"docs/deploy.md\"\n";

    struct Fixture {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        worktree: PathBuf,
        reg: Registry,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let primary = tmp.path().join("app");
        let worktree = tmp.path().join("wt").join("app-oak");
        for dir in [&data, &primary, &worktree] {
            fs::create_dir_all(dir).unwrap();
        }
        let reg = Registry {
            version: 1,
            repos: vec![RepoEntry {
                id: "abc".into(),
                short_name: "app".into(),
                path: primary,
                base_ref: "main".into(),
                worktree_root: tmp.path().join("wt"),
                ..RepoEntry::default()
            }],
            worktrees: vec![WorktreeMeta {
                repo_id: "abc".into(),
                path: worktree.clone(),
                start: "0".repeat(40),
                pinned: false,
                created_ms: 0,
                made_here: true,
                ..WorktreeMeta::default()
            }],
            vaults: Vec::new(),
            ..Registry::default()
        };
        Fixture {
            _tmp: tmp,
            data,
            worktree,
            reg,
        }
    }

    fn view(f: &Fixture, config: Option<&str>) -> TargetsView {
        view_of(&f.reg, &f.data, &f.worktree, |_| false, config).unwrap()
    }

    #[test]
    fn list_merges_detected_and_repo_presets_and_asks_for_trust() {
        let f = fixture();
        fs::write(f.worktree.join("vercel.json"), "{}").unwrap();
        fs::write(f.worktree.join("xdev.toml"), TOML).unwrap();
        let v = view(&f, Some("Host prod-1\n  HostName 10.0.0.1\n"));
        let names: Vec<_> = v.deploy.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Vercel preview", "Vercel production", "Staging"]);
        assert!(!v.trusted);
        assert!(v.text.as_deref().is_some_and(|t| t.contains("make stage")));
        assert_eq!(v.vps.as_ref().map(|s| s.host.as_str()), Some("prod-1"));
        assert!(v.vps_host_known);

        deploy::trust_targets(&f.reg, &f.data, &f.worktree, &v.hash, 1).unwrap();
        let trusted = view(&f, None);
        assert!(trusted.trusted);
        assert!(!trusted.vps_host_known);

        fs::write(f.worktree.join("xdev.toml"), TOML.replace("stage", "ship")).unwrap();
        assert!(!view(&f, None).trusted);
    }

    #[test]
    fn list_without_a_file_is_detected_only_and_trusted() {
        let f = fixture();
        fs::write(f.worktree.join("wrangler.toml"), "").unwrap();
        let v = view(&f, None);
        assert_eq!(v.deploy.len(), 1);
        assert_eq!(v.deploy[0].run, "npx wrangler deploy");
        assert!(v.trusted && v.vps.is_none() && v.vps_host_known);
    }

    #[test]
    fn a_saved_host_is_known() {
        let f = fixture();
        let host = xdev_ssh::SshHost {
            id: "h1".into(),
            alias: "prod-1".into(),
            host_name: "10.0.0.1".into(),
            ..xdev_ssh::SshHost::default()
        };
        assert!(!vps_host_unknown(&[host], None, "prod-1"));
        assert!(vps_host_unknown(&[], Some("Host other\n"), "prod-1"));
        drop(f);
    }

    #[test]
    fn notes_must_be_a_file_under_the_worktree() {
        let f = fixture();
        let vps = |notes: &str| VpsTarget {
            host: "prod-1".into(),
            cwd: None,
            notes: Some(notes.into()),
        };
        assert_eq!(notes_in(None, &f.worktree), None);
        assert_eq!(notes_in(Some(&vps("docs/deploy.md")), &f.worktree), None);
        fs::create_dir_all(f.worktree.join("docs")).unwrap();
        fs::write(f.worktree.join("docs").join("deploy.md"), "# deploy").unwrap();
        assert_eq!(
            notes_in(Some(&vps("docs/deploy.md")), &f.worktree).as_deref(),
            Some("docs/deploy.md")
        );
        // A folder is not a notes file, and `..` never leaves the worktree.
        assert_eq!(notes_in(Some(&vps("docs")), &f.worktree), None);
        fs::write(f.worktree.join("..").join("outside.md"), "x").unwrap();
        assert_eq!(notes_in(Some(&vps("../outside.md")), &f.worktree), None);
    }
}
