use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use xdev_git::GhAccount;

use crate::WorkspaceError;
use crate::groups::{FolderEntry, RepoGroup};
use crate::kept::KeptBranch;

const FILE: &str = "workspace.json";
const VERSION: u32 = 1;

/// A repo the app was asked to track.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoEntry {
    pub id: String,
    pub short_name: String,
    pub path: PathBuf,
    pub base_ref: String,
    /// The folder new worktrees of this repo go under.
    pub worktree_root: PathBuf,
    /// Whether a new worktree's setup script runs. Absent in older files.
    #[serde(default)]
    pub setup_policy: SetupPolicy,
    /// Which scripts count: the shared `xdev.toml` ones, this machine's, or both.
    #[serde(default)]
    pub script_source: ScriptSource,
    /// This machine's setup script. Typed in xDev, so it is trusted.
    #[serde(default)]
    pub local_setup: String,
    /// This machine's archive script, run before a worktree is removed.
    #[serde(default)]
    pub local_archive: String,
    /// The folder of this repo's docs, relative to the primary checkout.
    /// `None` means `docs`. Absent in older files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_dir: Option<String>,
    /// A `REPO_COLORS` name or `#rgb` / `#rrggbb`; `None` is the neutral badge.
    #[serde(default)]
    pub color: Option<String>,
    /// `None` shows the first letter of the short name.
    #[serde(default)]
    pub icon: Option<RepoIcon>,
    /// The `gh` login this repo's `gh` calls run as; `None` is `gh`'s own default.
    #[serde(default)]
    pub gh_account: Option<GhAccount>,
    /// This machine's issue prompt template.
    #[serde(default)]
    pub local_issue_command: String,
    /// Named folder lists a sparse worktree can start from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sparse_presets: Vec<SparsePreset>,
    /// Environment rows for this repo's terminals. A secret row's value is
    /// in the keychain, not here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<crate::RepoEnvVar>,
}

/// A named list of folders a sparse worktree is limited to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SparsePreset {
    pub name: String,
    pub dirs: Vec<String>,
}

/// Most sparse presets a repo keeps.
pub const SPARSE_PRESETS_MAX: usize = 20;
/// Longest sparse preset name, in characters.
pub const SPARSE_PRESET_NAME_MAX: usize = 60;

/// The colour names a repo badge has a design token for.
pub const REPO_COLORS: [&str; 8] = [
    "slate", "red", "orange", "yellow", "green", "teal", "violet", "pink",
];

/// Longest issue command, in bytes.
pub const ISSUE_COMMAND_MAX: usize = 64 * 1024;

/// What a repo badge shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RepoIcon {
    /// The first letter of the short name.
    Letter,
    /// One grapheme, at most 16 bytes.
    Emoji { value: String },
}

/// Whether setup runs after a worktree is created.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SetupPolicy {
    /// The person decides on each create.
    #[default]
    Ask,
    Run,
    Skip,
}

/// Which script runs when both the repo file and this machine have one.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ScriptSource {
    /// `Local` when a local script exists, else `Shared`.
    #[default]
    Auto,
    Shared,
    Local,
    /// The shared script, a newline, then the local one.
    Both,
}

/// What the app knows about a linked worktree that git does not. Every
/// field after `made_here` is absent in older files.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeMeta {
    pub repo_id: String,
    pub path: PathBuf,
    /// A full commit id.
    pub start: String,
    pub pinned: bool,
    pub created_ms: i64,
    /// Created by the app, not found already in git's list.
    pub made_here: bool,
    /// The name shown instead of the folder name; may hold emoji.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub status: Option<WorkStatus>,
    /// Another worktree of the same repo this one is shown under.
    #[serde(default)]
    pub parent: Option<PathBuf>,
    /// The pull request or issue the work is for; a link, never fetched.
    #[serde(default)]
    pub item: Option<WorkItem>,
    #[serde(default)]
    pub made_by: MadeBy,
    /// The branch name was picked by the app (a blank name at creation) and
    /// no rename has happened since; older files read `false`, so those
    /// worktrees are never renamed on their own.
    #[serde(default)]
    pub auto_name: bool,
    /// When the app CLI last created or changed this worktree; the sidebar
    /// marks it "by CLI".
    #[serde(default)]
    pub set_by_cli_ms: Option<i64>,
}

/// Where the work in a worktree stands, as the person sets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum WorkStatus {
    Todo,
    InProgress,
    InReview,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum WorkItemKind {
    Pr,
    Issue,
    /// A task file of the repo's board, `.xdev/tasks/<id>.md`.
    Task,
}

/// A link to a pull request or issue, typed by the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct WorkItem {
    pub kind: WorkItemKind,
    pub url: String,
    pub title: Option<String>,
}

/// Who asked for a worktree: the desktop app, the CLI or an automation.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum MadeBy {
    #[default]
    App,
    Cli,
    Automation,
}

/// A docs folder shared across repos. Only these are stored; a repo's own
/// vault is derived from its checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultEntry {
    /// The 12-hex path hash `repo_id` makes.
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub repos: Vec<RepoEntry>,
    pub worktrees: Vec<WorktreeMeta>,
    /// Absent in files written before vaults existed.
    #[serde(default)]
    pub vaults: Vec<VaultEntry>,
    /// Branches left in git when their worktree was archived or deleted.
    #[serde(default)]
    pub kept: Vec<KeptBranch>,
    /// Top-level sidebar ids (repos, folders, groups) in shown order.
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub groups: Vec<RepoGroup>,
    /// Plain folders listed in the sidebar.
    #[serde(default)]
    pub folders: Vec<FolderEntry>,
}

impl Registry {
    /// A missing file is an empty registry.
    pub fn load(data_dir: &Path) -> Result<Registry, WorkspaceError> {
        let text = match fs::read_to_string(data_dir.join(FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registry {
                    version: VERSION,
                    ..Registry::default()
                });
            }
            Err(e) => return Err(e.into()),
        };
        let reg: Registry =
            serde_json::from_str(&text).map_err(|e| WorkspaceError::Corrupt(e.to_string()))?;
        if reg.version != VERSION {
            return Err(WorkspaceError::Corrupt(format!(
                "unknown version {}",
                reg.version
            )));
        }
        Ok(reg)
    }

    /// Writes a temp file beside the target, then renames it over, so a
    /// crash leaves the old file or the new one, never half of one. A
    /// registry built with `Default` is written as the current version.
    pub fn save(&self, data_dir: &Path) -> Result<(), WorkspaceError> {
        fs::create_dir_all(data_dir)?;
        let out = Registry {
            version: VERSION,
            ..self.clone()
        };
        let json =
            serde_json::to_vec_pretty(&out).map_err(|e| WorkspaceError::Corrupt(e.to_string()))?;
        write_atomic(data_dir, FILE, &json)
    }
}

/// Writes `dir/name` through a temp file and a rename. Flushed to disk
/// before the rename, so the name never points at a file whose contents are
/// still in the cache.
pub(crate) fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), WorkspaceError> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, dir.join(name))
    };
    write().inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// The path with `\` as `/`, lowercased on Windows where the file system
/// ignores case: the one form two spellings of a folder agree on.
pub(crate) fn normalize(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// The first 12 hex digits of the hash of the normalized path.
pub fn repo_id(path: &Path) -> String {
    let mut hex = blake3::hash(normalize(path).as_bytes())
        .to_hex()
        .to_string();
    hex.truncate(12);
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_an_empty_registry() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.version, 1);
        assert!(r.repos.is_empty());
    }

    #[test]
    fn save_is_atomic_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        r.repos.push(RepoEntry {
            id: "abc".into(),
            short_name: "xdev".into(),
            path: "/r".into(),
            base_ref: "main".into(),
            worktree_root: "/wt".into(),
            ..RepoEntry::default()
        });
        r.save(dir.path()).unwrap();
        assert_eq!(Registry::load(dir.path()).unwrap(), r);
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["workspace.json"]); // no temp file left behind
    }

    #[test]
    fn loads_file_without_vaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":1,"repos":[],"worktrees":[]}"#,
        )
        .unwrap();
        let r = Registry::load(dir.path()).unwrap();
        assert!(r.vaults.is_empty());
    }

    #[test]
    fn loads_a_repo_without_script_settings_as_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":1,"repos":[{"id":"abc","short_name":"xdev","path":"/r","base_ref":"main","worktree_root":"/wt"}],"worktrees":[]}"#,
        )
        .unwrap();
        let r = Registry::load(dir.path()).unwrap();
        let repo = &r.repos[0];
        assert_eq!(repo.setup_policy, SetupPolicy::Ask);
        assert_eq!(repo.script_source, ScriptSource::Auto);
        assert_eq!(repo.local_setup, "");
        assert_eq!(repo.local_archive, "");
    }

    #[test]
    fn docs_dir_is_absent_in_old_files_and_survives_a_save() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":1,"repos":[{"id":"abc","short_name":"xdev","path":"/r","base_ref":"main","worktree_root":"/wt"}],"worktrees":[]}"#,
        )
        .unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.repos[0].docs_dir, None);
        r.save(dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        assert!(!text.contains("docs_dir"));
        r.repos[0].docs_dir = Some("handbook".into());
        r.save(dir.path()).unwrap();
        assert_eq!(Registry::load(dir.path()).unwrap(), r);
    }

    #[test]
    fn sparse_presets_are_absent_in_old_files_and_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":1,"repos":[{"id":"abc","short_name":"xdev","path":"/r","base_ref":"main","worktree_root":"/wt"}],"worktrees":[]}"#,
        )
        .unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        assert!(r.repos[0].sparse_presets.is_empty());
        r.save(dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        assert!(!text.contains("sparse_presets"));
        r.repos[0].sparse_presets = vec![SparsePreset {
            name: "web".into(),
            dirs: vec!["apps/web".into()],
        }];
        r.save(dir.path()).unwrap();
        assert_eq!(Registry::load(dir.path()).unwrap(), r);
    }

    #[test]
    fn script_settings_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        r.repos.push(RepoEntry {
            id: "abc".into(),
            short_name: "xdev".into(),
            setup_policy: SetupPolicy::Run,
            script_source: ScriptSource::Both,
            local_setup: "make".into(),
            local_archive: "echo bye".into(),
            ..RepoEntry::default()
        });
        r.save(dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["repos"][0]["setup_policy"], "run");
        assert_eq!(json["repos"][0]["script_source"], "both");
        assert_eq!(Registry::load(dir.path()).unwrap(), r);
    }

    #[test]
    fn vaults_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        r.vaults.push(VaultEntry {
            id: "0123456789ab".into(),
            path: "/v".into(),
        });
        r.save(dir.path()).unwrap();
        assert_eq!(Registry::load(dir.path()).unwrap().vaults, r.vaults);
    }

    #[test]
    fn unknown_version_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            r#"{"version":2,"repos":[],"worktrees":[]}"#,
        )
        .unwrap();
        assert_eq!(
            Registry::load(dir.path()).unwrap_err().code(),
            "registry_corrupt"
        );
    }

    #[test]
    fn repo_id_ignores_slash_style_and_case_on_windows() {
        if cfg!(windows) {
            assert_eq!(
                repo_id(Path::new(r"E:\Codes\xDev\xdev")),
                repo_id(Path::new("e:/codes/xdev/xdev"))
            );
        }
        assert_eq!(repo_id(Path::new("/a")).len(), 12);
    }

    #[test]
    fn a_task_work_item_loads_and_older_files_still_do() {
        let dir = tempfile::tempdir().unwrap();
        let old = r#"{"version":1,"repos":[],"worktrees":[{"repo_id":"a","path":"/w/a","start":"s","pinned":false,"created_ms":1,"made_here":true,"item":{"kind":"issue","url":"https://x.test/1","title":null}}]}"#;
        std::fs::write(dir.path().join("workspace.json"), old).unwrap();
        let reg = Registry::load(dir.path()).unwrap();
        assert_eq!(
            reg.worktrees[0].item.as_ref().unwrap().kind,
            WorkItemKind::Issue
        );
        let new = old.replace(
            r#""kind":"issue","url":"https://x.test/1""#,
            r#""kind":"task","url":".xdev/tasks/t7k2m9q.md""#,
        );
        std::fs::write(dir.path().join("workspace.json"), new).unwrap();
        let reg = Registry::load(dir.path()).unwrap();
        assert_eq!(
            reg.worktrees[0].item.as_ref().unwrap().kind,
            WorkItemKind::Task
        );
        reg.save(dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        assert!(text.contains(r#""kind": "task""#));
    }
}
