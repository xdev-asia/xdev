use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    /// Kept as the user picked it: the canonical root is a `\\?\` path on
    /// Windows, which the folder dialog and the UI should never see.
    pub last_vault: Option<String>,
    /// Set once the first-run folder offer was answered either way.
    #[serde(default)]
    pub vault_prompted: bool,
    /// Settings → Git. A section that does not parse falls back to the
    /// defaults on its own, so it never costs the rest of the file.
    #[serde(default, deserialize_with = "lenient")]
    pub git: GitSettings,
    /// Settings → Notifications; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub status: StatusSettings,
}

/// How agent status reaches the person. A channel fires only when `enabled`,
/// its event switch and the channel switch are all on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct StatusSettings {
    // Master switch for every channel below.
    pub enabled: bool,
    // Which events notify.
    pub on_needs_input: bool,
    pub on_done: bool,
    pub on_failed: bool,
    // A terminal bell on a pane the person is not looking at.
    pub on_bell: bool,
    // No notification for a pane the person is looking at.
    pub suppress_when_focused: bool,
    // Agent launches get the per-process hook flags (new sessions only).
    pub hooks: bool,
    // OS notification for a pane the person is not looking at.
    pub os: bool,
    pub sound: bool,
    // The person's own sound, copied under the data folder; `None` is the
    // built-in beep.
    pub sound_file: Option<String>,
    // 0–100.
    pub volume: u8,
    // The header bell's count and list.
    pub bell: bool,
    // The taskbar or dock badge.
    pub badge: bool,
}

impl Default for StatusSettings {
    fn default() -> Self {
        StatusSettings {
            enabled: true,
            on_needs_input: true,
            on_done: true,
            on_failed: true,
            on_bell: false,
            suppress_when_focused: true,
            hooks: true,
            os: true,
            sound: true,
            sound_file: None,
            volume: 60,
            bell: true,
            badge: true,
        }
    }
}

/// What goes in front of new branch names.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum BranchPrefixMode {
    /// The repo's git `user.name`.
    #[default]
    GitUsername,
    /// `branch_prefix_custom`.
    Custom,
    None,
}

/// Settings → Git. Every field has a default, so a file from an older
/// version, or one missing a field, still loads.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct GitSettings {
    pub branch_prefix: BranchPrefixMode,
    /// Kept normalized; may still be unusable, which creating a worktree
    /// reports.
    pub branch_prefix_custom: String,
    /// Fetch the base and fast-forward its local branch before a worktree
    /// is created.
    pub refresh_local_base_on_create: bool,
    /// Count a branch's committed changes against its upstream rather than
    /// the repo's base ref.
    pub compare_against_upstream: bool,
    /// Show the agent actions in Source Control: drafting a commit message
    /// or a pull request, and fixing a failed commit.
    pub source_control_ai: bool,
    /// A new pull request starts as a draft.
    pub pr_draft: bool,
    /// Draft the pull request's title and body when Create PR opens.
    pub pr_generate_on_open: bool,
    /// Open the pull request in the browser once it is created.
    pub pr_open_after_create: bool,
}

impl Default for GitSettings {
    /// The reference app's defaults: the git username as the prefix, agent
    /// actions shown, everything else off.
    fn default() -> GitSettings {
        GitSettings {
            branch_prefix: BranchPrefixMode::default(),
            branch_prefix_custom: String::new(),
            refresh_local_base_on_create: false,
            compare_against_upstream: false,
            source_control_ai: true,
            pr_draft: false,
            pr_generate_on_open: false,
            pr_open_after_create: false,
        }
    }
}

impl GitSettings {
    /// As stored: the custom prefix normalized the way names use it.
    pub fn normalized(mut self) -> GitSettings {
        self.branch_prefix_custom = xdev_workspace::normalize_prefix(&self.branch_prefix_custom);
        self
    }

    /// How a new worktree is named under these settings.
    pub fn create_options(&self) -> xdev_workspace::CreateOptions {
        use xdev_workspace::BranchPrefix;
        let prefix = match self.branch_prefix {
            BranchPrefixMode::GitUsername => BranchPrefix::GitUsername,
            BranchPrefixMode::Custom => BranchPrefix::Custom(self.branch_prefix_custom.clone()),
            BranchPrefixMode::None => BranchPrefix::None,
        };
        xdev_workspace::CreateOptions { prefix }
    }
}

/// One settings section: a value that does not parse becomes its defaults.
fn lenient<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

pub const FILE_NAME: &str = "settings.json";

/// A missing or unreadable file means first launch; refusing to start over a
/// broken settings file would leave the user stuck.
pub fn load(path: &Path) -> Settings {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(io::Error::other)?;
    fs::write(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        let settings = Settings {
            last_vault: Some("C:/Users/me/Tài liệu".into()),
            vault_prompted: true,
            git: GitSettings {
                branch_prefix: BranchPrefixMode::Custom,
                branch_prefix_custom: "team/me".into(),
                refresh_local_base_on_create: true,
                compare_against_upstream: true,
                source_control_ai: false,
                pr_draft: true,
                pr_generate_on_open: true,
                pr_open_after_create: true,
            },
            status: StatusSettings {
                hooks: false,
                sound_file: Some("C:/x/custom.wav".into()),
                volume: 7,
                ..StatusSettings::default()
            },
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"last_vault\""), "{raw}");
        assert!(raw.contains("\"branchPrefix\": \"custom\""), "{raw}");
        assert!(raw.contains("\"refreshLocalBaseOnCreate\": true"), "{raw}");
        assert!(raw.contains("\"compareAgainstUpstream\": true"), "{raw}");
    }

    #[test]
    fn git_defaults_match_the_reference_app() {
        let git = GitSettings::default();
        assert_eq!(git.branch_prefix, BranchPrefixMode::GitUsername);
        assert_eq!(git.branch_prefix_custom, "");
        assert!(!git.refresh_local_base_on_create);
        assert!(!git.compare_against_upstream);
        assert!(git.source_control_ai);
        assert!(!git.pr_draft && !git.pr_generate_on_open && !git.pr_open_after_create);
        // A file from before these fields gets the same.
        let old: GitSettings = serde_json::from_str(r#"{"branchPrefix":"none"}"#).unwrap();
        assert!(old.source_control_ai);
        assert_eq!(old.branch_prefix, BranchPrefixMode::None);
    }

    #[test]
    fn a_bad_git_section_keeps_the_rest_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let raw = r#"{ "last_vault": "D:/docs", "git": { "branchPrefix": "jira" } }"#;
        fs::write(&path, raw).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
        assert_eq!(loaded.git, GitSettings::default());

        // A partial section keeps what it has.
        fs::write(&path, r#"{ "git": { "branchPrefix": "none" } }"#).unwrap();
        assert_eq!(load(&path).git.branch_prefix, BranchPrefixMode::None);

        // So does a bad status section.
        let raw = r#"{ "last_vault": "D:/docs", "status": { "volume": "loud" } }"#;
        fs::write(&path, raw).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
        assert_eq!(loaded.status, StatusSettings::default());
    }

    #[test]
    fn normalized_tidies_the_custom_prefix_only() {
        let git = GitSettings {
            branch_prefix: BranchPrefixMode::Custom,
            branch_prefix_custom: " /team//me/ ".into(),
            refresh_local_base_on_create: true,
            ..GitSettings::default()
        }
        .normalized();
        assert_eq!(git.branch_prefix_custom, "team/me");
        assert!(git.refresh_local_base_on_create);
        // An unusable prefix is kept, so the person sees it to fix it.
        let bad = GitSettings {
            branch_prefix_custom: "a b".into(),
            ..GitSettings::default()
        };
        assert_eq!(bad.normalized().branch_prefix_custom, "a b");
    }

    #[test]
    fn create_options_follow_the_mode() {
        use xdev_workspace::BranchPrefix;
        let mut git = GitSettings {
            branch_prefix_custom: "team".into(),
            ..GitSettings::default()
        };
        assert_eq!(git.create_options().prefix, BranchPrefix::GitUsername);
        git.branch_prefix = BranchPrefixMode::Custom;
        assert_eq!(
            git.create_options().prefix,
            BranchPrefix::Custom("team".into())
        );
        git.branch_prefix = BranchPrefixMode::None;
        assert_eq!(git.create_options().prefix, BranchPrefix::None);
    }

    #[test]
    fn file_from_before_the_prompt_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "last_vault": "D:/docs" }"#).unwrap();
        assert_eq!(
            load(&path),
            Settings {
                last_vault: Some("D:/docs".into()),
                vault_prompted: false,
                git: GitSettings::default(),
                status: StatusSettings::default(),
            }
        );
    }

    #[test]
    fn settings_without_status_load_with_hooks_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "last_vault": "D:/docs" }"#).unwrap();
        let status = load(&path).status;
        assert_eq!(status, StatusSettings::default());
        assert!(status.hooks && status.os && status.sound && status.bell && status.badge);
        assert_eq!((status.volume, status.sound_file), (60, None));
    }

    #[test]
    fn status_is_camel_case_and_fills_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{ "status": { "soundFile": "a.wav", "bell": false } }"#,
        )
        .unwrap();
        let status = load(&path).status;
        assert_eq!(
            status,
            StatusSettings {
                sound_file: Some("a.wav".into()),
                bell: false,
                ..StatusSettings::default()
            }
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["soundFile"], "a.wav");
        assert_eq!(json["volume"], 60);
    }

    #[test]
    fn a_4a_status_loads_the_4b_switches_at_their_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let old = r#"{ "status": { "hooks": false, "os": true, "sound": false,
            "soundFile": null, "volume": 30, "bell": true, "badge": false } }"#;
        fs::write(&path, old).unwrap();
        let status = load(&path).status;
        assert!(status.enabled && status.on_needs_input && status.on_done && status.on_failed);
        assert!(!status.on_bell && status.suppress_when_focused);
        assert_eq!(
            (status.hooks, status.sound, status.volume, status.badge),
            (false, false, 30, false)
        );
        let json = serde_json::to_value(&status).unwrap();
        for key in [
            "enabled",
            "onNeedsInput",
            "onDone",
            "onFailed",
            "onBell",
            "suppressWhenFocused",
        ] {
            assert!(json[key].is_boolean(), "{key}");
        }
    }

    #[test]
    fn missing_or_broken_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert_eq!(load(&path), Settings::default());
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
    }
}
