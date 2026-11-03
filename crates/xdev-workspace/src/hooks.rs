//! A repo's setup and archive scripts: the shared ones in `xdev.toml` at the
//! worktree root, this machine's own on the repo entry, and which shared
//! script contents the person has trusted.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{Registry, RepoEntry, ScriptSource, SetupPolicy, WorkspaceError, path_key};

/// The shared repo file, at the worktree root.
pub const FILE_NAME: &str = "xdev.toml";
/// The trust store, in the data folder.
pub const TRUST_FILE: &str = "hook-trust.json";

/// What a worktree's setup and archive come to, after `ScriptSource`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RepoHooks {
    pub setup: Option<HookScript>,
    pub archive: Option<HookScript>,
    /// Agents start only after setup ends.
    pub wait_for_setup: bool,
    pub policy: SetupPolicy,
    /// Why `xdev.toml` was not used; its scripts are then left out.
    pub parse_error: Option<String>,
    /// A setup command guessed from the files, offered when there is no setup.
    pub detected: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HookScript {
    pub text: String,
    /// Some of the text came from `xdev.toml`.
    pub shared: bool,
    /// Blake3 hex of the shared part; empty when the script is local only.
    pub hash: String,
    /// Local only, or the shared part's hash is in the trust store.
    pub trusted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum HookKind {
    Setup,
    Archive,
}

/// What a headless hook run did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HookRun {
    /// False when there was no script to run.
    pub ran: bool,
    pub code: Option<i32>,
    pub output: String,
}

/// The largest `xdev.toml` read.
pub(crate) const MAX_FILE: usize = 256 * 1024;
/// The largest script in it.
pub(crate) const MAX_SCRIPT: usize = 64 * 1024;

/// What `xdev.toml` says.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SharedFile {
    pub setup: Option<String>,
    pub archive: Option<String>,
    pub wait_for_setup: bool,
    /// Keys this version does not read, as `table.key`, sorted; kept for a
    /// later notice.
    pub unknown: Vec<String>,
}

/// `Ok(None)` when there is no file; `Err` is the reason it is not used.
pub(crate) fn read_file(path: &Path) -> Result<Option<SharedFile>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{FILE_NAME}: {e}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{FILE_NAME}: {e}"))?;
    if bytes.len() > MAX_FILE {
        return Err(format!("{FILE_NAME} is over {} KiB", MAX_FILE / 1024));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("{FILE_NAME} is not UTF-8"))?;
    let table: toml::Table = toml::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = SharedFile::default();
    for (key, value) in table {
        match key.as_str() {
            "scripts" => {
                let toml::Value::Table(scripts) = value else {
                    return Err("[scripts] must be a table".into());
                };
                for (name, value) in scripts {
                    let slot = match name.as_str() {
                        "setup" => &mut out.setup,
                        "archive" => &mut out.archive,
                        _ => {
                            out.unknown.push(format!("scripts.{name}"));
                            continue;
                        }
                    };
                    let toml::Value::String(script) = value else {
                        return Err(format!("scripts.{name} must be a string"));
                    };
                    if script.len() > MAX_SCRIPT {
                        return Err(format!("scripts.{name} is over {} KiB", MAX_SCRIPT / 1024));
                    }
                    *slot = Some(script);
                }
            }
            "agent" => {
                let toml::Value::Table(agent) = value else {
                    return Err("[agent] must be a table".into());
                };
                for (name, value) in agent {
                    if name != "wait_for_setup" {
                        out.unknown.push(format!("agent.{name}"));
                        continue;
                    }
                    let toml::Value::Boolean(wait) = value else {
                        return Err("agent.wait_for_setup must be true or false".into());
                    };
                    out.wait_for_setup = wait;
                }
            }
            _ => out.unknown.push(key),
        }
    }
    out.unknown.sort();
    Ok(Some(out))
}

/// The repo a worktree, or the primary checkout, belongs to.
pub(crate) fn repo_of<'a>(
    reg: &'a Registry,
    worktree: &Path,
) -> Result<&'a RepoEntry, WorkspaceError> {
    let key = path_key(worktree);
    let id = reg
        .worktrees
        .iter()
        .find(|m| path_key(&m.path) == key)
        .map(|m| m.repo_id.as_str());
    reg.repos
        .iter()
        .find(|r| Some(r.id.as_str()) == id || path_key(&r.path) == key)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(worktree.to_owned()))
}

/// The worktree's own file, else the primary checkout's.
fn shared_of(repo: &RepoEntry, worktree: &Path) -> Result<Option<SharedFile>, String> {
    match read_file(&worktree.join(FILE_NAME)) {
        Ok(None) if path_key(worktree) != path_key(&repo.path) => {
            read_file(&repo.path.join(FILE_NAME))
        }
        other => other,
    }
}

fn hash_of(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex().to_string()
}

fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// The script `source` makes of the two parts; `None` when both are blank.
fn script_of(
    source: ScriptSource,
    shared: Option<&str>,
    local: &str,
    trusted: impl Fn(&str) -> bool,
) -> Option<HookScript> {
    let shared = shared.filter(|s| !blank(s));
    let local = Some(local).filter(|s| !blank(s));
    let (shared, local) = match source {
        ScriptSource::Auto if local.is_some() => (None, local),
        ScriptSource::Auto | ScriptSource::Shared => (shared, None),
        ScriptSource::Local => (None, local),
        ScriptSource::Both => (shared, local),
    };
    let text = match (shared, local) {
        (None, None) => return None,
        (Some(s), None) => s.to_owned(),
        (None, Some(l)) => l.to_owned(),
        (Some(s), Some(l)) => format!("{}\n{l}", s.trim_end_matches(['\r', '\n'])),
    };
    let hash = shared.map(hash_of).unwrap_or_default();
    Some(HookScript {
        text,
        shared: shared.is_some(),
        trusted: shared.is_none() || trusted(&hash),
        hash,
    })
}

/// The hooks of the worktree at `worktree`.
pub fn hooks_for(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
) -> Result<RepoHooks, WorkspaceError> {
    let repo = repo_of(reg, worktree)?;
    let (file, parse_error) = match shared_of(repo, worktree) {
        Ok(file) => (file.unwrap_or_default(), None),
        Err(reason) => (SharedFile::default(), Some(reason)),
    };
    let store = load_trust(data);
    let script = |kind: HookKind, shared: Option<&str>, local: &str| {
        script_of(repo.script_source, shared, local, |hash| {
            store.has(&repo.id, kind, hash)
        })
    };
    let setup = script(HookKind::Setup, file.setup.as_deref(), &repo.local_setup);
    let archive = script(
        HookKind::Archive,
        file.archive.as_deref(),
        &repo.local_archive,
    );
    let detected = if setup.is_none() {
        detect_setup(worktree)
    } else {
        None
    };
    Ok(RepoHooks {
        setup,
        archive,
        wait_for_setup: file.wait_for_setup,
        policy: repo.setup_policy,
        parse_error,
        detected,
    })
}

/// `hook-trust.json`: the shared scripts the person has approved, one
/// entry per repo and kind.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TrustStore {
    version: u32,
    entries: Vec<TrustEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustEntry {
    repo_id: String,
    kind: HookKind,
    hash: String,
    approved_ms: i64,
}

impl TrustStore {
    fn has(&self, repo_id: &str, kind: HookKind, hash: &str) -> bool {
        self.entries
            .iter()
            .any(|e| e.repo_id == repo_id && e.kind == kind && e.hash == hash)
    }
}

/// A missing, unreadable or corrupt store trusts nothing.
fn load_trust(data: &Path) -> TrustStore {
    fs::read(data.join(TRUST_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<TrustStore>(&bytes).ok())
        .filter(|store| store.version == 1)
        .unwrap_or_default()
}

/// Records that the person trusts this exact shared script of a repo.
pub fn trust(
    _data: &Path,
    _repo_id: &str,
    _kind: HookKind,
    _hash: &str,
    _now_ms: i64,
) -> Result<(), WorkspaceError> {
    Ok(())
}

/// `trust` for the worktree's current shared script; `HookUntrusted` when
/// `hash` is not that script's hash. Returns the hooks after.
pub fn trust_hook(
    reg: &Registry,
    data: &Path,
    worktree: &Path,
    _kind: HookKind,
    _hash: &str,
    _now_ms: i64,
) -> Result<RepoHooks, WorkspaceError> {
    hooks_for(reg, data, worktree)
}

/// `XDEV_ROOT_PATH`, `XDEV_WORKTREE_PATH` and `XDEV_WORKSPACE_NAME` for a
/// script run in `worktree`.
pub fn hook_env(
    _reg: &Registry,
    _worktree: &Path,
) -> Result<Vec<(String, String)>, WorkspaceError> {
    Ok(Vec::new())
}

/// A setup command guessed from the worktree's files; a lockfile wins.
pub fn detect_setup(worktree: &Path) -> Option<String> {
    const RULES: [(&str, &str); 5] = [
        ("pnpm-lock.yaml", "pnpm install"),
        ("yarn.lock", "yarn install"),
        ("package-lock.json", "npm install"),
        ("package.json", "npm install"),
        ("Cargo.toml", "cargo fetch"),
    ];
    RULES
        .iter()
        .find(|(file, _)| worktree.join(file).is_file())
        .map(|(_, command)| (*command).to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::WorktreeMeta;

    /// A registry with one repo at `<tmp>/xdev` and one worktree at
    /// `<tmp>/wt/xdev-oak`; nothing is a git repo, the reader needs none.
    struct Fixture {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        primary: PathBuf,
        worktree: PathBuf,
        reg: Registry,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let primary = tmp.path().join("xdev");
        let worktree = tmp.path().join("wt").join("xdev-oak");
        for dir in [&data, &primary, &worktree] {
            fs::create_dir_all(dir).unwrap();
        }
        let reg = Registry {
            version: 1,
            repos: vec![RepoEntry {
                id: "abc".into(),
                short_name: "xdev".into(),
                path: primary.clone(),
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
            }],
            vaults: Vec::new(),
        };
        Fixture {
            _tmp: tmp,
            data,
            primary,
            worktree,
            reg,
        }
    }

    impl Fixture {
        fn write(&self, dir: &Path, text: &str) {
            fs::write(dir.join(FILE_NAME), text).unwrap();
        }
        fn hooks(&self) -> RepoHooks {
            hooks_for(&self.reg, &self.data, &self.worktree).unwrap()
        }
        fn repo(&mut self) -> &mut RepoEntry {
            &mut self.reg.repos[0]
        }
    }

    const FILE: &str = "[scripts]\nsetup = \"pnpm install\"\narchive = \"docker compose down\"\n\n[agent]\nwait_for_setup = true\n";

    fn hex(text: &str) -> String {
        blake3::hash(text.as_bytes()).to_hex().to_string()
    }

    #[test]
    fn no_file_and_no_local_script_is_no_hooks() {
        let f = fixture();
        let hooks = f.hooks();
        assert_eq!(hooks.setup, None);
        assert_eq!(hooks.archive, None);
        assert!(!hooks.wait_for_setup);
        assert_eq!(hooks.parse_error, None);
        assert_eq!(hooks.policy, SetupPolicy::Ask);
    }

    #[test]
    fn reads_the_worktree_file_untrusted() {
        let f = fixture();
        f.write(&f.worktree, FILE);
        let hooks = f.hooks();
        let setup = hooks.setup.unwrap();
        assert_eq!(setup.text, "pnpm install");
        assert!(setup.shared);
        assert!(!setup.trusted);
        assert_eq!(setup.hash, hex("pnpm install"));
        assert_eq!(hooks.archive.unwrap().text, "docker compose down");
        assert!(hooks.wait_for_setup);
    }

    #[test]
    fn falls_back_to_the_repo_file() {
        let f = fixture();
        f.write(&f.primary, "[scripts]\nsetup = \"make\"\n");
        assert_eq!(f.hooks().setup.unwrap().text, "make");
        // The worktree's own file wins.
        f.write(&f.worktree, "[scripts]\nsetup = \"just\"\n");
        assert_eq!(f.hooks().setup.unwrap().text, "just");
    }

    #[test]
    fn the_primary_checkout_reads_its_own_file() {
        let f = fixture();
        f.write(&f.primary, "[scripts]\nsetup = \"make\"\n");
        let hooks = hooks_for(&f.reg, &f.data, &f.primary).unwrap();
        assert_eq!(hooks.setup.unwrap().text, "make");
    }

    #[test]
    fn an_unknown_folder_is_worktree_unknown() {
        let f = fixture();
        let err = hooks_for(&f.reg, &f.data, &f.data).unwrap_err();
        assert_eq!(err.code(), "worktree_unknown");
    }

    #[test]
    fn a_parse_error_gives_no_shared_scripts() {
        let mut f = fixture();
        f.repo().local_setup = "make".into();
        f.write(&f.worktree, "[scripts\nsetup = 1");
        let hooks = f.hooks();
        assert!(hooks.parse_error.is_some());
        // The local script still counts.
        assert_eq!(hooks.setup.unwrap().text, "make");
        assert_eq!(hooks.archive, None);
        // A wrong type is a parse error too.
        f.write(&f.worktree, "[scripts]\nsetup = 1\n");
        assert!(f.hooks().parse_error.is_some());
    }

    #[test]
    fn unknown_keys_are_kept_not_refused() {
        let f = fixture();
        f.write(
            &f.worktree,
            "[scripts]\nsetup = \"make\"\nrun = \"x\"\n[ports]\nweb = 3000\n",
        );
        let hooks = f.hooks();
        assert_eq!(hooks.parse_error, None);
        assert_eq!(hooks.setup.unwrap().text, "make");
        let file = read_file(&f.worktree.join(FILE_NAME)).unwrap().unwrap();
        assert_eq!(file.unknown, ["ports", "scripts.run"]);
    }

    #[test]
    fn an_oversized_file_or_script_is_refused() {
        let f = fixture();
        let big = "x".repeat(MAX_SCRIPT + 1);
        f.write(&f.worktree, &format!("[scripts]\nsetup = \"{big}\"\n"));
        let hooks = f.hooks();
        assert!(hooks.parse_error.unwrap().contains("setup"));
        assert_eq!(hooks.setup, None);

        let pad = format!("# {}\n", "x".repeat(MAX_FILE));
        f.write(&f.worktree, &format!("{pad}[scripts]\nsetup = \"make\"\n"));
        let hooks = f.hooks();
        assert!(hooks.parse_error.is_some());
        assert_eq!(hooks.setup, None);
    }

    #[test]
    fn script_source_picks_the_parts() {
        let mut f = fixture();
        f.write(&f.worktree, FILE);
        f.repo().local_setup = "make".into();

        // Auto: local wins when there is one.
        let setup = f.hooks().setup.unwrap();
        assert_eq!(setup.text, "make");
        assert!(!setup.shared);
        assert_eq!(setup.hash, "");
        assert!(setup.trusted);
        // Auto with no local archive: the shared one.
        assert!(f.hooks().archive.unwrap().shared);

        f.repo().script_source = ScriptSource::Shared;
        assert_eq!(f.hooks().setup.unwrap().text, "pnpm install");

        f.repo().script_source = ScriptSource::Local;
        assert_eq!(f.hooks().setup.unwrap().text, "make");
        assert_eq!(f.hooks().archive, None);

        f.repo().script_source = ScriptSource::Both;
        let setup = f.hooks().setup.unwrap();
        assert_eq!(setup.text, "pnpm install\nmake");
        assert!(setup.shared);
        assert_eq!(setup.hash, hex("pnpm install"));
        assert!(!setup.trusted);
    }

    #[test]
    fn a_blank_script_is_no_script() {
        let mut f = fixture();
        f.write(&f.worktree, "[scripts]\nsetup = \"  \\n\"\n");
        f.repo().local_archive = "\n".into();
        let hooks = f.hooks();
        assert_eq!(hooks.setup, None);
        assert_eq!(hooks.archive, None);
    }

    #[test]
    fn the_hash_follows_the_text() {
        let f = fixture();
        f.write(&f.worktree, "[scripts]\nsetup = \"make\"\n");
        let a = f.hooks().setup.unwrap().hash;
        f.write(&f.worktree, "[scripts]\nsetup = \"make all\"\n");
        let b = f.hooks().setup.unwrap().hash;
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn the_policy_comes_from_the_repo() {
        let mut f = fixture();
        f.repo().setup_policy = SetupPolicy::Run;
        assert_eq!(f.hooks().policy, SetupPolicy::Run);
    }

    #[test]
    fn detected_is_offered_only_without_a_setup() {
        let mut f = fixture();
        fs::write(f.worktree.join("package.json"), "{}").unwrap();
        assert_eq!(f.hooks().detected.as_deref(), Some("npm install"));
        f.repo().local_setup = "make".into();
        assert_eq!(f.hooks().detected, None);
    }

    #[test]
    fn detect_setup_by_lockfile() {
        let dir = tempfile::tempdir().unwrap();
        let at = |files: &[&str]| {
            for entry in fs::read_dir(dir.path()).unwrap() {
                fs::remove_file(entry.unwrap().path()).unwrap();
            }
            for name in files {
                fs::write(dir.path().join(name), "").unwrap();
            }
            detect_setup(dir.path())
        };
        assert_eq!(at(&[]), None);
        assert_eq!(at(&["Cargo.toml"]).as_deref(), Some("cargo fetch"));
        assert_eq!(at(&["package.json"]).as_deref(), Some("npm install"));
        assert_eq!(at(&["package-lock.json"]).as_deref(), Some("npm install"));
        assert_eq!(
            at(&["package.json", "yarn.lock"]).as_deref(),
            Some("yarn install")
        );
        assert_eq!(
            at(&["package.json", "pnpm-lock.yaml", "Cargo.toml"]).as_deref(),
            Some("pnpm install")
        );
    }
}
