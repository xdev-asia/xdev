use std::fs;
use std::io::{self, Write};
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The shape `save` writes. Bump it with a step in `MIGRATIONS` when a key
/// is renamed or removed; a new field with a default needs neither.
pub const VERSION: u32 = 1;

/// `MIGRATIONS[i]` turns a version `i + 1` file into version `i + 2`; they
/// run in order on the raw JSON before it is parsed, so a step can rename
/// or move keys. Version 0 (no `version` key) has the shape of version 1.
const MIGRATIONS: &[fn(&mut serde_json::Value)] = &[];
const _: () = assert!(MIGRATIONS.len() as u32 + 1 == VERSION);
/// Emitted after every settings write, with a `SettingsChanged` payload.
pub const CHANGED_EVENT: &str = "settings://changed";

/// Not `Eq`: `terminal.line_height` is an `f32`.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    /// The version the file was written as: 0 for files from before the
    /// settings store. `save` always writes `VERSION`.
    #[serde(default, deserialize_with = "lenient")]
    pub version: u32,
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
    /// Settings → Terminal; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub terminal: TerminalSettings,
}

/// How every terminal pane looks and behaves. Values outside the ranges
/// below are clamped when stored.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    /// Empty means the `--x-font-mono` token.
    pub font_family: String,
    /// 8..=32.
    pub font_size: u8,
    pub font_weight: FontWeight,
    /// 1.0..=2.0.
    pub line_height: f32,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    /// Lines kept above the screen, 0..=100_000.
    pub scrollback: u32,
    pub copy_on_select: bool,
    /// Off on macOS, on elsewhere, as the reference app does.
    pub right_click_paste: bool,
    /// Programs may write the clipboard with OSC 52; they can never read it.
    pub osc52_clipboard: bool,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        TerminalSettings {
            font_family: String::new(),
            font_size: 13,
            font_weight: FontWeight::Normal,
            line_height: 1.0,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            scrollback: 10_000,
            copy_on_select: true,
            right_click_paste: !cfg!(target_os = "macos"),
            osc52_clipboard: true,
        }
    }
}

impl TerminalSettings {
    pub const FONT_SIZE: RangeInclusive<u8> = 8..=32;
    pub const LINE_HEIGHT: RangeInclusive<f32> = 1.0..=2.0;
    pub const MAX_SCROLLBACK: u32 = 100_000;

    /// As stored: every number inside its range.
    pub fn clamped(mut self) -> Self {
        self.font_size = self
            .font_size
            .clamp(*Self::FONT_SIZE.start(), *Self::FONT_SIZE.end());
        self.line_height = if self.line_height.is_finite() {
            self.line_height
                .clamp(*Self::LINE_HEIGHT.start(), *Self::LINE_HEIGHT.end())
        } else {
            *Self::LINE_HEIGHT.start()
        };
        self.scrollback = self.scrollback.min(Self::MAX_SCROLLBACK);
        self
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum FontWeight {
    #[default]
    Normal,
    Medium,
    Bold,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    #[default]
    Block,
    Bar,
    Underline,
}

/// One part of the settings file, as a `settings://changed` event names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SettingsSection {
    /// `last_vault` and `vault_prompted`.
    Vault,
    Git,
    Status,
    Terminal,
}

/// What a `settings://changed` event carries.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SettingsChanged {
    pub sections: Vec<SettingsSection>,
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
/// broken settings file would leave the user stuck. An older file is
/// migrated in memory and keeps its `version` until the next save; a newer
/// one loads as it is, and keys this build does not know are dropped then.
pub fn load(path: &Path) -> Settings {
    let Some(mut value) = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter(serde_json::Value::is_object)
    else {
        return Settings::default();
    };
    let version = file_version(&value);
    if version > VERSION {
        warn_newer(path, version);
    }
    migrate(&mut value, MIGRATIONS);
    serde_json::from_value(value).unwrap_or_default()
}

/// 0 when the key is missing or not a number.
fn file_version(value: &serde_json::Value) -> u32 {
    value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .map_or(0, |v| u32::try_from(v).unwrap_or(u32::MAX))
}

/// Runs the `steps` a file at its version still needs.
fn migrate(value: &mut serde_json::Value, steps: &[fn(&mut serde_json::Value)]) {
    let from = file_version(value).max(1) as usize;
    for step in steps.iter().skip(from - 1) {
        step(value);
    }
}

/// Once per run: every read of a newer file would say the same.
fn warn_newer(path: &Path, version: u32) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "settings: {} is version {version}, newer than this build's {VERSION};              keys this build does not know are dropped on the next save",
            path.display()
        );
    }
}

/// Writes `settings.json.tmp` beside the file, then renames it over, so a
/// crash or a full disk leaves the old file or the new one, never half of
/// one.
/// Always as `VERSION`.
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let current = Settings {
        version: VERSION,
        ..settings.clone()
    };
    let json = serde_json::to_vec_pretty(&current).map_err(io::Error::other)?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    // Flushed before the rename, so the name never points at bytes still
    // in the cache.
    let write = || -> io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    };
    write().inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        let settings = Settings {
            version: VERSION,
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
            terminal: TerminalSettings {
                font_size: 15,
                cursor_style: CursorStyle::Bar,
                ..TerminalSettings::default()
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
                ..Settings::default()
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
    fn save_replaces_the_file_through_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let tmp = dir.path().join(format!("{FILE_NAME}.tmp"));
        let old = Settings {
            last_vault: Some("D:/old".into()),
            ..Settings::default()
        };
        save(&path, &old).unwrap();
        assert!(!tmp.exists());

        // A write that cannot finish leaves the old file whole: a folder
        // squatting on the temp name makes it fail on every platform.
        fs::create_dir(&tmp).unwrap();
        let new = Settings {
            last_vault: Some("D:/new".into()),
            ..Settings::default()
        };
        assert!(save(&path, &new).is_err());
        assert_eq!(load(&path).last_vault.as_deref(), Some("D:/old"));

        fs::remove_dir(&tmp).unwrap();
        save(&path, &new).unwrap();
        assert_eq!(load(&path).last_vault.as_deref(), Some("D:/new"));
        assert!(!tmp.exists());
    }

    #[test]
    fn an_old_file_loads_as_version_0_and_saves_as_the_current_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "last_vault": "D:/docs" }"#).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.version, 0);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
        // Loading alone writes nothing.
        assert!(!fs::read_to_string(&path).unwrap().contains("version"));

        save(&path, &loaded).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], VERSION);
        assert_eq!(raw["last_vault"], "D:/docs");
        let again = load(&path);
        assert_eq!(again.version, VERSION);
        assert_eq!(again.last_vault.as_deref(), Some("D:/docs"));
    }

    #[test]
    fn a_newer_file_loads_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let raw = r#"{ "version": 99, "last_vault": "D:/docs", "fromTheFuture": 1,
            "git": { "branchPrefix": "none" } }"#;
        fs::write(&path, raw).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.version, 99);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
        assert_eq!(loaded.git.branch_prefix, BranchPrefixMode::None);
    }

    #[test]
    fn migrations_run_in_order_from_the_file_version() {
        fn rename_a(v: &mut serde_json::Value) {
            let a = v["a"].take();
            v["b"] = a;
        }
        fn rename_b(v: &mut serde_json::Value) {
            let b = v["b"].take();
            v["c"] = b;
        }
        let steps: &[fn(&mut serde_json::Value)] = &[rename_a, rename_b];
        // Version 0 has the shape of version 1, so both steps run.
        for from in [0, 1] {
            let mut v = serde_json::json!({ "version": from, "a": 7 });
            migrate(&mut v, steps);
            assert_eq!(v["c"], 7, "from {from}");
        }
        // A version-2 file only needs the second.
        let mut v = serde_json::json!({ "version": 2, "b": 7 });
        migrate(&mut v, steps);
        assert_eq!(v["c"], 7);
        // Up to date or newer: untouched.
        for from in [3, 99] {
            let mut v = serde_json::json!({ "version": from, "a": 7 });
            migrate(&mut v, steps);
            assert_eq!(v["a"], 7, "from {from}");
        }
    }

    #[test]
    fn terminal_round_trips_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let terminal = TerminalSettings {
            font_family: "Cascadia Code".into(),
            font_size: 15,
            font_weight: FontWeight::Medium,
            line_height: 1.2,
            cursor_style: CursorStyle::Underline,
            cursor_blink: false,
            scrollback: 5_000,
            copy_on_select: false,
            right_click_paste: false,
            osc52_clipboard: false,
        };
        let settings = Settings {
            terminal: terminal.clone(),
            ..Settings::default()
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path).terminal, terminal);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"lineHeight\": 1.2,"), "{raw}");
        assert!(raw.contains("\"cursorStyle\": \"underline\""), "{raw}");
        assert!(raw.contains("\"fontWeight\": \"medium\""), "{raw}");

        // A bad terminal section costs only itself.
        fs::write(
            &path,
            r#"{ "last_vault": "D:/docs", "terminal": { "cursorStyle": "beam" } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
        assert_eq!(loaded.terminal, TerminalSettings::default());
    }

    #[test]
    fn terminal_clamps_to_its_ranges() {
        let wild = TerminalSettings {
            font_size: 200,
            scrollback: 10_000_000,
            line_height: 0.1,
            ..TerminalSettings::default()
        }
        .clamped();
        assert_eq!(
            (wild.font_size, wild.scrollback, wild.line_height),
            (32, 100_000, 1.0)
        );
        let low = TerminalSettings {
            font_size: 0,
            line_height: 9.0,
            ..TerminalSettings::default()
        }
        .clamped();
        assert_eq!((low.font_size, low.line_height), (8, 2.0));
        let nan = TerminalSettings {
            line_height: f32::NAN,
            ..TerminalSettings::default()
        }
        .clamped();
        assert_eq!(nan.line_height, 1.0);
        // In range: untouched.
        let fine = TerminalSettings {
            font_size: 14,
            line_height: 1.4,
            scrollback: 0,
            ..TerminalSettings::default()
        };
        assert_eq!(fine.clone().clamped(), fine);
    }

    /// `TERMINAL_DEFAULTS` in the UI and the generated binding name the same
    /// fields as Rust, with the same default values.
    #[test]
    fn terminal_defaults_match_the_ui() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let rust = serde_json::to_value(TerminalSettings::default()).unwrap();
        let rust = rust.as_object().unwrap();

        let binding =
            fs::read_to_string(root.join("packages/bindings/src/TerminalSettings.ts")).unwrap();
        for key in rust.keys() {
            assert!(binding.contains(&format!("{key}: ")), "binding lacks {key}");
        }

        let ui =
            fs::read_to_string(root.join("apps/desktop/src/settings/terminalDefaults.ts")).unwrap();
        let body = ui
            .split_once("TERMINAL_DEFAULTS: TerminalSettings = {")
            .and_then(|(_, rest)| rest.split_once("};"))
            .map(|(body, _)| body)
            .expect("TERMINAL_DEFAULTS literal");
        let mut seen = Vec::new();
        for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let (key, value) = line
                .trim_end_matches(',')
                .split_once(": ")
                .unwrap_or_else(|| panic!("{line}"));
            let want = rust.get(key).unwrap_or_else(|| panic!("UI has {key}"));
            if value == "!IS_MAC" {
                assert_eq!(
                    want,
                    &serde_json::json!(!cfg!(target_os = "macos")),
                    "{key}"
                );
            } else {
                let got: serde_json::Value = serde_json::from_str(value).unwrap();
                match (got.as_f64(), want.as_f64()) {
                    (Some(a), Some(b)) => assert!((a - b).abs() < 1e-6, "{key}: {a} != {b}"),
                    _ => assert_eq!(&got, want, "{key}"),
                }
            }
            seen.push(key.to_owned());
        }
        seen.sort();
        let mut keys: Vec<_> = rust.keys().cloned().collect();
        keys.sort();
        assert_eq!(seen, keys);
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
