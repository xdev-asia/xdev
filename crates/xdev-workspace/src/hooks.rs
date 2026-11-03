//! A repo's setup and archive scripts: the shared ones in `xdev.toml` at the
//! worktree root, this machine's own on the repo entry, and which shared
//! script contents the person has trusted.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{Registry, SetupPolicy, WorkspaceError};

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

/// The hooks of the worktree at `worktree`.
pub fn hooks_for(
    _reg: &Registry,
    _data: &Path,
    _worktree: &Path,
) -> Result<RepoHooks, WorkspaceError> {
    Ok(RepoHooks {
        setup: None,
        archive: None,
        wait_for_setup: false,
        policy: SetupPolicy::default(),
        parse_error: None,
        detected: None,
    })
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
pub fn detect_setup(_worktree: &Path) -> Option<String> {
    None
}
