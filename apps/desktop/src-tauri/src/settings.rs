use std::fs;
use std::io;
use std::ops::RangeInclusive;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::atomic::write_atomic;
use xdev_git::PullPolicy;

use crate::quick_commands::QuickCommand;

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
    /// Settings → Shortcuts: how keys behave with a terminal focused. The
    /// bindings themselves live in `keybindings.json`, not here.
    #[serde(default, deserialize_with = "lenient")]
    pub keys: KeySettings,
    /// Window-wide view settings (zoom) until a General page exists.
    #[serde(default, deserialize_with = "lenient")]
    pub ui: UiSettings,
    /// Settings → Quick commands, in the order the person keeps them. An
    /// entry that does not parse is dropped on its own.
    #[serde(default, rename = "quickCommands", deserialize_with = "lenient_items")]
    pub quick_commands: Vec<QuickCommand>,
    /// Ids of the recently run quick commands, newest first.
    #[serde(
        default,
        rename = "quickCommandsRecent",
        deserialize_with = "lenient_items"
    )]
    pub quick_commands_recent: Vec<String>,
    /// Settings → Open In Apps: the programs a worktree can be opened in.
    #[serde(default, deserialize_with = "lenient")]
    pub open_in: OpenInSettings,
    /// Settings → Editor, for file tabs; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub editor: EditorSettings,
    /// The sidebar's filters; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub sidebar: SidebarPrefs,
    /// Settings → General, Navigation group; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub navigation: NavigationSettings,
    /// Settings → General, Diff group; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub diff: DiffSettings,
    /// Settings → Agents; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub agents: AgentsSettings,
    /// Settings → Stats & Usage; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub usage: UsageSettings,
    /// Settings → xDev ID; lenient the same way.
    #[serde(default, rename = "xdevId", deserialize_with = "lenient")]
    pub xdev_id: XdevIdSettings,
    /// Settings → Orchestration; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub orchestration: OrchestrationSettings,
    /// Settings → General, Window and Updates groups; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub shell: ShellSettings,
}

/// Settings → xDev ID.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct XdevIdSettings {
    /// The origin of an on-prem xDev ID server. Empty: the default service. Read at
    /// startup and on save; `XDEV_ID_URL` wins over it.
    pub server: String,
}

/// The deepest nesting of dispatched workers Settings allows.
pub const NESTED_DEPTH_MAX: u32 = 9;

/// Settings → Orchestration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct OrchestrationSettings {
    /// How many generations of dispatched workers may start workers of their
    /// own; 1 keeps the agent tree flat.
    pub nested_worker_max_depth: u32,
    /// Close a worker's tab 2 minutes after it finishes.
    pub worker_auto_close: bool,
}

impl Default for OrchestrationSettings {
    fn default() -> Self {
        Self {
            nested_worker_max_depth: 1,
            worker_auto_close: true,
        }
    }
}

/// Which update feed the app follows.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    /// Release candidates, ahead of the stable release.
    Rc,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for UpdateChannel {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = String::deserialize(d)?;
        Ok(match v.as_str() {
            "rc" => Self::Rc,
            _ => Self::Stable,
        })
    }
}

/// Settings → General: Window and Updates groups.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct ShellSettings {
    /// Windows only: closing the window hides it to the tray.
    pub minimize_to_tray: bool,
    /// macOS only: the menu bar icon; on unless the person turned it off.
    pub menu_bar_icon: bool,
    /// Set once the "still running in the tray" notice was shown. Only the
    /// shell sets it; a `put` keeps the stored value.
    pub tray_notice_shown: bool,
    pub update_channel: UpdateChannel,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            minimize_to_tray: false,
            menu_bar_icon: true,
            tray_notice_shown: false,
            update_channel: UpdateChannel::Stable,
        }
    }
}

impl OrchestrationSettings {
    /// What `orchestration_settings_put` stores: the depth clamped to 1..=9.
    pub fn normalized(mut self) -> Self {
        self.nested_worker_max_depth = self.nested_worker_max_depth.clamp(1, NESTED_DEPTH_MAX);
        self
    }
}

impl ShellSettings {
    /// What `shell_settings_put` stores: the person's switches, with the
    /// notice flag kept from `stored`.
    pub fn for_put(self, stored: &ShellSettings) -> Self {
        Self {
            tray_notice_shown: stored.tray_notice_shown,
            ..self
        }
    }
}

/// What happens to the agent tabs that run under the old active account
/// when the person switches it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SwitchRunning {
    /// A dialog lists the tabs and the person ticks the ones to restart.
    #[default]
    Ask,
    /// Every such tab restarts under the new account.
    Restart,
    /// The tabs keep running under the old account.
    Keep,
}

/// Settings → Agents.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct AgentsSettings {
    pub account_switch: SwitchRunning,
    /// Whether the OS may sleep; an unknown stored value reads as `Off`.
    #[serde(deserialize_with = "lenient")]
    pub keep_awake: KeepAwake,
    /// Whether an agent tab is titled from its session's first prompt.
    #[serde(deserialize_with = "lenient")]
    pub auto_tab_title: bool,
    /// Experimental: finished agent tabs sleep after `sleep_after_min` idle minutes.
    pub auto_sleep: bool,
    /// Idle minutes before an agent tab sleeps, held to `SLEEP_AFTER_MIN_RANGE`.
    pub sleep_after_min: u32,
    /// Consent to index agent conversations on this computer.
    pub session_search: bool,
}

/// Settings → Agents → Keep computer awake.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum KeepAwake {
    /// Always asks the OS not to sleep.
    On,
    /// Asks only while an agent tab works.
    Agent,
    /// Never asks.
    #[default]
    Off,
}

/// Minutes an agent tab may idle before it sleeps: 1 minute to 24 hours.
pub const SLEEP_AFTER_MIN_RANGE: std::ops::RangeInclusive<u32> = 1..=1440;
/// Default idle minutes before an agent tab sleeps.
pub const SLEEP_AFTER_MIN_DEFAULT: u32 = 30;

impl Default for AgentsSettings {
    fn default() -> Self {
        Self {
            account_switch: SwitchRunning::default(),
            keep_awake: KeepAwake::default(),
            auto_tab_title: false,
            auto_sleep: false,
            sleep_after_min: SLEEP_AFTER_MIN_DEFAULT,
            session_search: false,
        }
    }
}

impl AgentsSettings {
    /// Holds `sleep_after_min` inside `SLEEP_AFTER_MIN_RANGE`.
    pub fn clamped(mut self) -> Self {
        self.sleep_after_min = self
            .sleep_after_min
            .clamp(*SLEEP_AFTER_MIN_RANGE.start(), *SLEEP_AFTER_MIN_RANGE.end());
        self
    }
}

/// Prompt cache lifetime, 5 minutes.
pub const CACHE_TTL_SHORT_MS: u32 = 300_000;
/// Prompt cache lifetime, 1 hour.
pub const CACHE_TTL_LONG_MS: u32 = 3_600_000;

/// Whether the footer meters show what is used or what is left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum UsageDisplay {
    #[default]
    Used,
    Remaining,
}

/// One switch per provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSwitches {
    pub claude: bool,
    pub codex: bool,
}

impl Default for ProviderSwitches {
    fn default() -> Self {
        Self {
            claude: true,
            codex: true,
        }
    }
}

/// Settings → Stats & Usage.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct UsageSettings {
    pub display: UsageDisplay,
    /// Which providers get a footer meter.
    pub footer: ProviderSwitches,
    /// Which providers' local session logs the Stats page may read. Off by
    /// default.
    pub scan: ProviderSwitches,
    /// A countdown on Claude tabs to the end of the prompt cache.
    pub cache_timer: bool,
    /// `CACHE_TTL_SHORT_MS` or `CACHE_TTL_LONG_MS`; `put` turns any other
    /// value into the short one.
    pub cache_ttl_ms: u32,
}

impl Default for UsageSettings {
    fn default() -> Self {
        Self {
            display: UsageDisplay::Used,
            footer: ProviderSwitches::default(),
            scan: ProviderSwitches {
                claude: false,
                codex: false,
            },
            cache_timer: false,
            cache_ttl_ms: CACHE_TTL_SHORT_MS,
        }
    }
}

impl UsageSettings {
    /// What `usage_settings_put` stores: a cache lifetime other than the two
    /// known ones is the short one.
    pub fn normalized(mut self) -> Self {
        if self.cache_ttl_ms != CACHE_TTL_LONG_MS {
            self.cache_ttl_ms = CACHE_TTL_SHORT_MS;
        }
        self
    }
}

/// How the sidebar splits worktree rows into sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SidebarGroupBy {
    /// The agent sections: needs you, working, review, the rest.
    #[default]
    Activity,
    None,
    Status,
    Pr,
    Project,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for SidebarGroupBy {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("none") => SidebarGroupBy::None,
            Some("status") => SidebarGroupBy::Status,
            Some("pr") => SidebarGroupBy::Pr,
            Some("project") => SidebarGroupBy::Project,
            _ => SidebarGroupBy::Activity,
        })
    }
}

/// How rows are ordered inside a sidebar section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SidebarSort {
    /// The order the person arranged.
    #[default]
    Manual,
    /// The most recent output first.
    Recent,
    /// By title, else name.
    Name,
    /// Agents that need attention first, then the newest activity.
    Smart,
    /// By repo, then label.
    Project,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for SidebarSort {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("recent") => SidebarSort::Recent,
            Some("name") => SidebarSort::Name,
            Some("smart") => SidebarSort::Smart,
            Some("project") => SidebarSort::Project,
            _ => SidebarSort::Manual,
        })
    }
}

/// How repo headings are ordered in the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ProjectOrder {
    /// The order the person arranged.
    #[default]
    Manual,
    /// The repo with the newest worktree activity first.
    Recent,
}

/// An unknown value is the default, as for `SidebarSort`.
impl<'de> serde::Deserialize<'de> for ProjectOrder {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("recent") => ProjectOrder::Recent,
            _ => ProjectOrder::Manual,
        })
    }
}

/// Which parts a detailed worktree card shows. All on by default.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct CardProps {
    pub branch: bool,
    pub time: bool,
    pub comment: bool,
    pub work_status: bool,
    pub work_item: bool,
    pub agents: bool,
    pub diff_stat: bool,
    pub pr: bool,
    pub project_chip: bool,
    pub ports: bool,
}

impl Default for CardProps {
    fn default() -> Self {
        CardProps {
            branch: true,
            time: true,
            comment: true,
            work_status: true,
            work_item: true,
            agents: true,
            diff_stat: true,
            pr: true,
            project_chip: true,
            ports: true,
        }
    }
}

/// The sidebar's filters, grouping, sort and card layout. All filters off:
/// every row shows.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct SidebarPrefs {
    /// Rows on the repo's default branch, the primary checkout included.
    pub hide_default: bool,
    pub hide_detached: bool,
    /// Worktrees made by an automation.
    pub hide_automation: bool,
    /// Worktrees made from the CLI.
    pub hide_cli: bool,
    pub group_by: SidebarGroupBy,
    pub sort: SidebarSort,
    /// One-line cards instead of the detailed ones.
    pub compact_cards: bool,
    pub card: CardProps,
    pub project_order: ProjectOrder,
    /// A pinned row also shows in its group.
    pub pinned_in_groups: bool,
}

/// The order Ctrl+Tab walks the tabs of a worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TabOrder {
    /// Most recently used first, as in the reference app.
    #[default]
    Mru,
    /// The order of the tab strip.
    Sequential,
}

/// An unknown value is the default, like `RestoreMode`, so one bad field
/// does not cost the section.
impl<'de> serde::Deserialize<'de> for TabOrder {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("sequential") => TabOrder::Sequential,
            _ => TabOrder::Mru,
        })
    }
}

/// Settings → General → Navigation. A field that does not parse falls back
/// to its default on its own.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct NavigationSettings {
    pub tab_order: TabOrder,
    /// Ask before closing a pinned tab.
    pub confirm_close_pinned: bool,
    /// Ask before closing a tab that has a running process.
    pub confirm_close_running: bool,
    pub ask_before_delete_worktree: bool,
    /// Delete a dirty worktree without the second confirmation.
    pub always_force_delete_worktrees: bool,
    /// Delete the branch with the folder even when it is not merged.
    pub always_delete_kept_branches: bool,
}

impl Default for NavigationSettings {
    fn default() -> Self {
        NavigationSettings {
            tab_order: TabOrder::default(),
            confirm_close_pinned: true,
            confirm_close_running: true,
            ask_before_delete_worktree: true,
            always_force_delete_worktrees: false,
            always_delete_kept_branches: false,
        }
    }
}

/// How a diff opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DiffView {
    #[default]
    Inline,
    Split,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for DiffView {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("split") => DiffView::Split,
            _ => DiffView::Inline,
        })
    }
}

/// Settings → General → Diff: the starting options of the review view.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct DiffSettings {
    pub default_view: DiffView,
    pub ignore_whitespace: bool,
    /// On, unlike the reference app: it is what xDev users have today.
    pub collapse_unchanged: bool,
    pub word_wrap: bool,
    /// Only stored; the combined diff does not draw a tree yet.
    pub file_tree: bool,
}

impl Default for DiffSettings {
    fn default() -> Self {
        DiffSettings {
            default_view: DiffView::default(),
            ignore_whitespace: false,
            collapse_unchanged: true,
            word_wrap: false,
            file_tree: false,
        }
    }
}

/// How file tabs edit. Values outside the ranges below are clamped when
/// stored.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct EditorSettings {
    /// Off, as in the reference app.
    pub autosave: bool,
    /// The wait after the last edit, 250..=10_000.
    pub autosave_ms: u32,
    /// 8..=32.
    pub font_size: u32,
    /// Empty follows the terminal font family.
    pub font_family: String,
    /// On by default; a stored `false` stays false.
    pub word_wrap: bool,
    /// Spaces for a new indent, 1..=8.
    pub tab_size: u32,
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            autosave: false,
            autosave_ms: 1000,
            font_size: 13,
            font_family: String::new(),
            word_wrap: true,
            tab_size: 4,
        }
    }
}

impl EditorSettings {
    pub const AUTOSAVE_MS: RangeInclusive<u32> = 250..=10_000;
    pub const FONT_SIZE: RangeInclusive<u32> = 8..=32;
    pub const TAB_SIZE: RangeInclusive<u32> = 1..=8;

    /// As stored: every number inside its range.
    pub fn clamped(mut self) -> Self {
        let within = |n: u32, r: &RangeInclusive<u32>| n.clamp(*r.start(), *r.end());
        self.autosave_ms = within(self.autosave_ms, &Self::AUTOSAVE_MS);
        self.font_size = within(self.font_size, &Self::FONT_SIZE);
        self.tab_size = within(self.tab_size, &Self::TAB_SIZE);
        self.font_family = clean_ui_font(&self.font_family);
        self
    }
}

/// The apps the Open in menu lists, in order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct OpenInSettings {
    /// At most `MAX_APPS`.
    pub apps: Vec<OpenInApp>,
}

impl Default for OpenInSettings {
    /// VS Code alone, as in the reference app.
    fn default() -> Self {
        OpenInSettings {
            apps: vec![OpenInApp {
                id: "vscode".into(),
                label: "VS Code".into(),
                command: "code".into(),
                args: Vec::new(),
            }],
        }
    }
}

/// One program the Open in menu can start with a folder. xDev never builds a
/// shell line from it: the program gets `args` and then the folder, each as
/// its own argument.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenInApp {
    /// `vscode` for the default, `app-<uuid>` for the person's own.
    pub id: String,
    /// 1..=40 characters.
    pub label: String,
    /// A program name or an absolute path, 1..=260 characters, no arguments.
    pub command: String,
    /// Arguments before the folder: at most 8, each at most 200 characters.
    #[serde(default)]
    pub args: Vec<String>,
}

impl OpenInSettings {
    pub const MAX_APPS: usize = 8;
    pub const MAX_LABEL: usize = 40;
    pub const MAX_COMMAND: usize = 260;
    pub const MAX_ARGS: usize = 8;
    pub const MAX_ARG: usize = 200;

    /// `Err` names the first rule the list breaks: `apps`, `id`, `label`,
    /// `command` or `args`.
    pub fn check(&self) -> Result<(), &'static str> {
        if self.apps.len() > Self::MAX_APPS {
            return Err("apps");
        }
        let mut ids = std::collections::HashSet::new();
        for app in &self.apps {
            if app.id.trim().is_empty() || !ids.insert(app.id.as_str()) {
                return Err("id");
            }
            app.check()?;
        }
        Ok(())
    }
}

impl OpenInApp {
    fn check(&self) -> Result<(), &'static str> {
        let len = |s: &str| s.chars().count();
        if self.label.trim().is_empty() || len(&self.label) > OpenInSettings::MAX_LABEL {
            return Err("label");
        }
        let command = &self.command;
        if command.trim().is_empty()
            || len(command) > OpenInSettings::MAX_COMMAND
            || command.contains('\0')
        {
            return Err("command");
        }
        // `code --new` would be a shell line; a real path may hold spaces.
        if command.chars().any(char::is_whitespace) {
            let path = std::path::Path::new(command);
            if !path.is_absolute() || !path.exists() {
                return Err("command");
            }
        }
        if self.args.len() > OpenInSettings::MAX_ARGS
            || self
                .args
                .iter()
                .any(|a| len(a) > OpenInSettings::MAX_ARG || a.contains('\0'))
        {
            return Err("args");
        }
        Ok(())
    }
}

/// Who gets a key that both the app and a focused terminal want.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum TerminalKeyPolicy {
    /// Every app shortcut wins, as in the reference app.
    #[default]
    AppFirst,
    /// Shortcuts marked as yielding go to the program in the terminal.
    TerminalFirst,
}

/// A value this build does not know reads as the default, so the hint
/// toggle beside it is kept (a failed field would reset the whole section).
impl<'de> serde::Deserialize<'de> for TerminalKeyPolicy {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("terminal-first") => TerminalKeyPolicy::TerminalFirst,
            _ => TerminalKeyPolicy::AppFirst,
        })
    }
}

/// Settings → Shortcuts, the part that is a setting rather than a binding.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct KeySettings {
    pub terminal_policy: TerminalKeyPolicy,
    /// A toast says so when the app took a key from a focused terminal.
    pub terminal_hints: bool,
}

impl Default for KeySettings {
    fn default() -> Self {
        KeySettings {
            terminal_policy: TerminalKeyPolicy::AppFirst,
            terminal_hints: true,
        }
    }
}

/// View settings of the whole window. Not `Eq`: `zoom` is an `f32`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct UiSettings {
    /// The root font scale, 0.5..=2.0; 1.0 is 100 %.
    pub zoom: f32,
    /// Which tabs come back on start. A file from before it loads `All`.
    pub restore: RestoreMode,
    /// Light, dark, or follow the system. A file from before it loads `System`.
    pub theme: Theme,
    /// Settings → Appearance → UI font. Empty is the `--font-body` token.
    /// Trimmed, control characters dropped, at most `UI_FONT_MAX` chars.
    #[serde(deserialize_with = "lenient")]
    pub ui_font: String,
    /// Token set the editor and diff view use while the app paints light.
    pub editor_theme_light: EditorTheme,
    /// Token set the editor and diff view use while the app paints dark.
    pub editor_theme_dark: EditorTheme,
    /// Left sidebar background.
    pub sidebar: SidebarLook,
    /// Which of xDev's own footer items show.
    #[serde(deserialize_with = "lenient")]
    pub status_bar: StatusBarItems,
}

/// The longest `UiSettings::ui_font`, in characters.
pub const UI_FONT_MAX: usize = 120;

impl Default for UiSettings {
    fn default() -> Self {
        UiSettings {
            zoom: 1.0,
            restore: RestoreMode::All,
            theme: Theme::System,
            ui_font: String::new(),
            editor_theme_light: EditorTheme::App,
            editor_theme_dark: EditorTheme::App,
            sidebar: SidebarLook::Default,
            status_bar: StatusBarItems::default(),
        }
    }
}

/// Settings → Appearance → Editor theme. A value this build does not know
/// reads as `App`, so it does not reset the zoom beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum EditorTheme {
    /// Follow the app theme.
    #[default]
    App,
    Light,
    Dark,
}

impl<'de> serde::Deserialize<'de> for EditorTheme {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("light") => EditorTheme::Light,
            Some("dark") => EditorTheme::Dark,
            _ => EditorTheme::App,
        })
    }
}

/// Settings → Appearance → Left sidebar. A value this build does not know
/// reads as `Default`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum SidebarLook {
    #[default]
    Default,
    Tinted,
}

impl<'de> serde::Deserialize<'de> for SidebarLook {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("tinted") => SidebarLook::Tinted,
            _ => SidebarLook::Default,
        })
    }
}

/// Settings → Appearance → Status bar: one switch per footer item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct StatusBarItems {
    pub branch: bool,
    pub token_usage: bool,
    pub agents: bool,
    pub version: bool,
    pub ports: bool,
}

impl Default for StatusBarItems {
    fn default() -> Self {
        StatusBarItems {
            branch: true,
            token_usage: true,
            agents: true,
            version: true,
            ports: true,
        }
    }
}

/// Settings → General → Theme. A value this build does not know reads as
/// `System`, so it does not reset the zoom beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Follow the operating system's light or dark setting.
    #[default]
    System,
    Dark,
    Light,
}

impl<'de> serde::Deserialize<'de> for Theme {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("dark") => Theme::Dark,
            Some("light") => Theme::Light,
            _ => Theme::System,
        })
    }
}

/// Settings → Terminal → On start, reopen tabs. A value this build does not
/// know reads as `All`, so it does not reset the zoom beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// Agent tabs resume their conversation; shell tabs start fresh.
    #[default]
    All,
    /// Only agent tabs come back.
    AgentsOnly,
    /// Nothing comes back.
    None,
}

impl<'de> serde::Deserialize<'de> for RestoreMode {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("agentsOnly") => RestoreMode::AgentsOnly,
            Some("none") => RestoreMode::None,
            _ => RestoreMode::All,
        })
    }
}

impl UiSettings {
    pub const ZOOM: RangeInclusive<f32> = 0.5..=2.0;

    /// As stored: the zoom inside its range; 1.0 when it is no number.
    pub fn clamped(mut self) -> Self {
        self.zoom = if self.zoom.is_finite() {
            self.zoom.clamp(*Self::ZOOM.start(), *Self::ZOOM.end())
        } else {
            1.0
        };
        self.ui_font = clean_ui_font(&self.ui_font);
        self
    }
}

/// Control characters dropped, trimmed, cut to `UI_FONT_MAX` characters.
fn clean_ui_font(raw: &str) -> String {
    let kept: String = raw.chars().filter(|c| !c.is_control()).collect();
    let cut: String = kept.trim().chars().take(UI_FONT_MAX).collect();
    cut.trim().to_string()
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
    /// PTYs run in the `xdev-ptyd` service and outlive the app; read at start.
    #[serde(deserialize_with = "lenient_service")]
    pub service: bool,
    /// What quitting the app does to the service's PTYs.
    #[serde(deserialize_with = "lenient")]
    pub on_quit: OnQuit,
    /// The service's output ring per PTY, in MB, 1..=16.
    #[serde(deserialize_with = "lenient_ring_mb")]
    pub ring_mb: u8,
    /// "app" or a built-in scheme id; `[a-z0-9-]{1,40}`, anything else is "app".
    #[serde(deserialize_with = "lenient_theme")]
    pub theme: String,
    #[serde(deserialize_with = "lenient")]
    pub gpu: TerminalGpu,
    #[serde(deserialize_with = "lenient")]
    pub bell: TerminalBell,
    /// Control chars dropped, at most 64 chars; empty reads as `DEFAULT_WORD_SEPARATORS`.
    #[serde(deserialize_with = "lenient_words")]
    pub word_separators: String,
    /// 0.5..=3.0.
    #[serde(deserialize_with = "lenient_scroll")]
    pub scroll_sensitivity: f32,
    /// 1.0..=10.0; xterm applies it with Alt held.
    #[serde(deserialize_with = "lenient_fast")]
    pub fast_scroll_sensitivity: f32,
    /// 1.0..=21.0; 1 is off.
    #[serde(deserialize_with = "lenient_contrast")]
    pub minimum_contrast: f32,
    #[serde(deserialize_with = "lenient_bool_false")]
    pub focus_follows_mouse: bool,
    /// macOS only: whether the Option key sends Alt/Esc sequences or composes characters.
    #[serde(deserialize_with = "lenient")]
    pub mac_option_as_alt: MacOptionAsAlt,
}

/// The default double-click word separators, the reference app's.
pub const DEFAULT_WORD_SEPARATORS: &str = " ()[]{}',\"`";
/// Most chars the word separators keep.
pub const WORD_SEPARATORS_MAX: usize = 64;
/// The theme id that means the xDev tokens.
pub const THEME_APP: &str = "app";

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
            service: true,
            on_quit: OnQuit::Keep,
            ring_mb: 2,
            theme: THEME_APP.into(),
            gpu: TerminalGpu::Auto,
            bell: TerminalBell::None,
            word_separators: DEFAULT_WORD_SEPARATORS.into(),
            scroll_sensitivity: 1.15,
            fast_scroll_sensitivity: 5.0,
            minimum_contrast: 1.0,
            focus_follows_mouse: false,
            mac_option_as_alt: MacOptionAsAlt::Auto,
        }
    }
}

impl TerminalSettings {
    pub const FONT_SIZE: RangeInclusive<u8> = 8..=32;
    pub const LINE_HEIGHT: RangeInclusive<f32> = 1.0..=2.0;
    pub const MAX_SCROLLBACK: u32 = 100_000;
    pub const RING_MB: RangeInclusive<u8> = 1..=16;
    pub const SCROLL: RangeInclusive<f32> = 0.5..=3.0;
    pub const FAST_SCROLL: RangeInclusive<f32> = 1.0..=10.0;
    pub const CONTRAST: RangeInclusive<f32> = 1.0..=21.0;

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
        self.ring_mb = self
            .ring_mb
            .clamp(*Self::RING_MB.start(), *Self::RING_MB.end());
        if !valid_theme_id(&self.theme) {
            self.theme = THEME_APP.into();
        }
        self.word_separators = clean_word_separators(&self.word_separators);
        let default = Self::default();
        self.scroll_sensitivity = clamp_or(
            self.scroll_sensitivity,
            Self::SCROLL,
            default.scroll_sensitivity,
        );
        self.fast_scroll_sensitivity = clamp_or(
            self.fast_scroll_sensitivity,
            Self::FAST_SCROLL,
            default.fast_scroll_sensitivity,
        );
        self.minimum_contrast = clamp_or(
            self.minimum_contrast,
            Self::CONTRAST,
            default.minimum_contrast,
        );
        self
    }
}

/// `[a-z0-9-]{1,40}`: what a scheme id may be.
fn valid_theme_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Control chars dropped, at most `WORD_SEPARATORS_MAX` chars; empty reads as the default.
fn clean_word_separators(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(WORD_SEPARATORS_MAX)
        .collect();
    if kept.is_empty() {
        DEFAULT_WORD_SEPARATORS.into()
    } else {
        kept
    }
}

/// `n` inside `range`; the default when it is not a finite number.
fn clamp_or(n: f32, range: RangeInclusive<f32>, default: f32) -> f32 {
    if n.is_finite() {
        n.clamp(*range.start(), *range.end())
    } else {
        default
    }
}

/// Settings → Terminal → "On quit". Ask is answered by the UI before the
/// window closes (`ptyd_quit_choice`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum OnQuit {
    #[default]
    Keep,
    End,
    Ask,
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

/// Settings → Terminal → "GPU acceleration": the WebGL renderer or the DOM one.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TerminalGpu {
    #[default]
    Auto,
    On,
    Off,
}

/// Settings → Terminal → "Bell": what a pane does on BEL.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TerminalBell {
    #[default]
    None,
    Visual,
    Sound,
}

/// Settings → Terminal → "Option as Alt" (macOS): which Option keys send Alt/Esc sequences.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum MacOptionAsAlt {
    #[default]
    Auto,
    Both,
    Left,
    Right,
    Off,
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
    Keys,
    Ui,
    /// `quickCommands` and their recently used order.
    QuickCommands,
    OpenIn,
    Editor,
    Sidebar,
    Navigation,
    Diff,
    Agents,
    Usage,
    XdevId,
    Orchestration,
    Shell,
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

/// Longest recipe template kept, in characters; a longer one is cut on save.
pub const RECIPE_TEMPLATE_MAX: usize = 16 * 1024;
/// Most extra CLI args a recipe keeps.
pub const RECIPE_ARGS_MAX: usize = 32;
/// The template that keeps the built-in prompt as it is.
pub const RECIPE_DEFAULT_TEMPLATE: &str = "{basePrompt}";

/// One agent action's prompt: who runs it and the text it is given.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct Recipe {
    /// A profile id from profiles.json; `None` is the default agent.
    pub agent: Option<String>,
    /// Extra CLI args for drafts; the fix actions run in a terminal tab and
    /// do not use them.
    pub args: Vec<String>,
    /// Text with `{variables}`; `{basePrompt}` is xDev's built-in prompt.
    pub template: String,
}

impl Default for Recipe {
    fn default() -> Recipe {
        Recipe {
            agent: None,
            args: Vec::new(),
            template: RECIPE_DEFAULT_TEMPLATE.to_owned(),
        }
    }
}

/// The agent actions of Source Control, each with its own recipe.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct GitRecipes {
    // Each recipe is lenient on its own: one with a wrong type costs only itself.
    #[serde(deserialize_with = "lenient")]
    pub commit_message: Recipe,
    #[serde(deserialize_with = "lenient")]
    pub pull_request: Recipe,
    #[serde(deserialize_with = "lenient")]
    pub fix_commit_failure: Recipe,
    #[serde(deserialize_with = "lenient")]
    pub fix_push_failure: Recipe,
    #[serde(deserialize_with = "lenient")]
    pub fix_checks: Recipe,
    /// Names a branch from the first prompt of its agent.
    #[serde(deserialize_with = "lenient")]
    pub branch_name: Recipe,
    /// Asks an agent to resolve the conflicts of a merge, rebase, cherry-pick
    /// or revert in progress.
    #[serde(deserialize_with = "lenient")]
    pub resolve_conflicts: Recipe,
    /// Asks an agent to address the review comments queued from a pull request.
    #[serde(deserialize_with = "lenient")]
    pub address_comments: Recipe,
}

impl Recipe {
    /// As stored: a template cut to `RECIPE_TEMPLATE_MAX` characters (a blank
    /// one is the default), at most `RECIPE_ARGS_MAX` args, a blank agent
    /// as none.
    fn normalized(mut self) -> Recipe {
        if self.template.trim().is_empty() {
            self.template = RECIPE_DEFAULT_TEMPLATE.to_owned();
        } else if let Some((end, _)) = self.template.char_indices().nth(RECIPE_TEMPLATE_MAX) {
            self.template.truncate(end);
        }
        self.args.truncate(RECIPE_ARGS_MAX);
        self.agent = self.agent.filter(|a| !a.trim().is_empty());
        self
    }
}

impl GitRecipes {
    fn normalized(self) -> GitRecipes {
        GitRecipes {
            commit_message: self.commit_message.normalized(),
            pull_request: self.pull_request.normalized(),
            fix_commit_failure: self.fix_commit_failure.normalized(),
            fix_push_failure: self.fix_push_failure.normalized(),
            fix_checks: self.fix_checks.normalized(),
            branch_name: self.branch_name.normalized(),
            resolve_conflicts: self.resolve_conflicts.normalized(),
            address_comments: self.address_comments.normalized(),
        }
    }
}

/// Most bot author overrides kept.
pub const BOT_OVERRIDES_MAX: usize = 500;
/// Longest login kept in the overrides.
const BOT_LOGIN_MAX: usize = 255;

/// Trimmed, lowercase, sorted and de-duplicated; blank and over-long entries
/// dropped; cut to `BOT_OVERRIDES_MAX`.
fn normalize_bot_overrides(logins: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = logins
        .into_iter()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty() && l.chars().count() <= BOT_LOGIN_MAX)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(BOT_OVERRIDES_MAX);
    out
}

/// Which Source Control group is drawn first. Conflicts stay on top.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SourceControlGroupOrder {
    #[default]
    ChangesFirst,
    StagedFirst,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for SourceControlGroupOrder {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("staged-first") => SourceControlGroupOrder::StagedFirst,
            _ => SourceControlGroupOrder::ChangesFirst,
        })
    }
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
    /// A worktree made with an automatic name gets a branch name from the
    /// first prompt its agent receives.
    pub auto_rename_branch: bool,
    /// Which group Source Control draws first.
    pub source_control_group_order: SourceControlGroupOrder,
    /// Logins (lowercase) treated as bots in a pull request's comments, on top
    /// of the ones GitHub marks as bots. A wrong type costs only this field.
    #[serde(deserialize_with = "lenient")]
    pub pr_bot_author_overrides: Vec<String>,
    /// How Pull and Sync combine local and remote commits.
    pub pull_policy: PullPolicy,
    /// The prompts behind the agent actions. A part that does not parse
    /// falls back to the defaults on its own.
    #[serde(deserialize_with = "lenient")]
    pub recipes: GitRecipes,
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
            auto_rename_branch: true,
            source_control_group_order: SourceControlGroupOrder::default(),
            pr_bot_author_overrides: Vec::new(),
            pull_policy: PullPolicy::default(),
            recipes: GitRecipes::default(),
        }
    }
}

impl GitSettings {
    /// As stored: the custom prefix normalized the way names use it.
    pub fn normalized(mut self) -> GitSettings {
        self.branch_prefix_custom = xdev_workspace::normalize_prefix(&self.branch_prefix_custom);
        self.recipes = self.recipes.normalized();
        self.pr_bot_author_overrides = normalize_bot_overrides(self.pr_bot_author_overrides);
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
        xdev_workspace::CreateOptions {
            prefix,
            made_by: xdev_workspace::MadeBy::App,
            // A taken name is made as `name-2`; the desktop never refuses it.
            suffix: true,
            ..xdev_workspace::CreateOptions::default()
        }
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

/// A service field that does not parse reads as its default, not the type's,
/// and leaves the rest of the terminal section alone.
fn lenient_service<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    Ok(serde_json::from_value(value).unwrap_or(TerminalSettings::default().service))
}

fn lenient_ring_mb<'de, D: serde::Deserializer<'de>>(de: D) -> Result<u8, D::Error> {
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    Ok(serde_json::from_value(value).unwrap_or(TerminalSettings::default().ring_mb))
}

/// A field that does not parse reads as its own default, not the type's.
fn lenient_or<'de, D, T>(de: D, default: T) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    Ok(serde_json::from_value(value).unwrap_or(default))
}

fn lenient_theme<'de, D: serde::Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    lenient_or(de, THEME_APP.to_owned())
}

fn lenient_words<'de, D: serde::Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    lenient_or(de, DEFAULT_WORD_SEPARATORS.to_owned())
}

fn lenient_scroll<'de, D: serde::Deserializer<'de>>(de: D) -> Result<f32, D::Error> {
    lenient_or(de, TerminalSettings::default().scroll_sensitivity)
}

fn lenient_fast<'de, D: serde::Deserializer<'de>>(de: D) -> Result<f32, D::Error> {
    lenient_or(de, TerminalSettings::default().fast_scroll_sensitivity)
}

fn lenient_contrast<'de, D: serde::Deserializer<'de>>(de: D) -> Result<f32, D::Error> {
    lenient_or(de, TerminalSettings::default().minimum_contrast)
}

fn lenient_bool_false<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    lenient_or(de, false)
}

/// A list section: an entry that does not parse is left out, the rest kept;
/// a value that is not a list reads as an empty one.
fn lenient_items<'de, D, T>(de: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    let serde_json::Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match serde_json::from_value(item) {
            Ok(item) => Some(item),
            Err(e) => {
                eprintln!("settings: dropped a list entry that does not parse: {e}");
                None
            }
        })
        .collect())
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

/// Replaces the file whole through a temp file beside it
/// ([`write_atomic`]). Always as `VERSION`.
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    let current = Settings {
        version: VERSION,
        ..settings.clone()
    };
    let json = serde_json::to_vec_pretty(&current).map_err(io::Error::other)?;
    write_atomic(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quick_commands::{QuickAction, QuickScope};

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
                auto_rename_branch: false,
                source_control_group_order: SourceControlGroupOrder::StagedFirst,
                pr_bot_author_overrides: vec!["renovate".into()],
                pull_policy: PullPolicy::GitConfig,
                recipes: GitRecipes::default(),
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
            ..Settings::default()
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
    fn a_file_without_recipes_gets_the_default_ones() {
        let old: GitSettings = serde_json::from_str(r#"{"prDraft":true}"#).unwrap();
        assert_eq!(old.recipes, GitRecipes::default());
        assert_eq!(old.recipes.commit_message.template, "{basePrompt}");
        assert_eq!(old.recipes.commit_message.agent, None);
        // One recipe given, the others default.
        let some: GitSettings =
            serde_json::from_str(r#"{"recipes":{"fixChecks":{"agent":"codex"}}}"#).unwrap();
        assert_eq!(some.recipes.fix_checks.agent.as_deref(), Some("codex"));
        assert_eq!(some.recipes.fix_checks.template, "{basePrompt}");
        assert_eq!(some.recipes.pull_request, Recipe::default());
    }

    #[test]
    fn a_bad_recipe_falls_back_on_its_own() {
        let raw = r#"{"recipes":{
            "commitMessage":{"agent":7,"template":"mine"},
            "pullRequest":{"template":"pr {branch}"},
            "fixPushFailure":"nope"}}"#;
        let git: GitSettings = serde_json::from_str(raw).unwrap();
        assert_eq!(git.recipes.commit_message, Recipe::default());
        assert_eq!(git.recipes.pull_request.template, "pr {branch}");
        assert_eq!(git.recipes.fix_push_failure, Recipe::default());
        // A wrong `recipes` value costs only the recipes.
        let git: GitSettings = serde_json::from_str(r#"{"prDraft":true,"recipes":[1]}"#).unwrap();
        assert!(git.pr_draft);
        assert_eq!(git.recipes, GitRecipes::default());
    }

    #[test]
    fn saving_cuts_a_long_template_and_many_args() {
        let mut git = GitSettings::default();
        git.recipes.commit_message.template = "é".repeat(RECIPE_TEMPLATE_MAX + 5);
        git.recipes.pull_request.args = (0..RECIPE_ARGS_MAX + 3).map(|i| i.to_string()).collect();
        git.recipes.fix_checks.template = "  \n".into();
        git.recipes.fix_push_failure.agent = Some(" ".into());
        let git = git.normalized();
        assert_eq!(
            git.recipes.commit_message.template.chars().count(),
            RECIPE_TEMPLATE_MAX
        );
        assert_eq!(git.recipes.pull_request.args.len(), RECIPE_ARGS_MAX);
        assert_eq!(git.recipes.fix_checks.template, "{basePrompt}");
        assert_eq!(git.recipes.fix_push_failure.agent, None);
        // A template within the cap is kept as typed.
        let mut ok = GitSettings::default();
        ok.recipes.commit_message.template = "Use conventional commits.\n{basePrompt}".into();
        assert_eq!(
            ok.clone().normalized().recipes.commit_message,
            ok.recipes.commit_message
        );
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
    fn bot_overrides_are_lowercased_sorted_deduped_and_capped() {
        let long = "x".repeat(256);
        let fit = "y".repeat(255);
        let git = GitSettings {
            pr_bot_author_overrides: vec![
                " Zed ".into(),
                "alpha".into(),
                "ALPHA".into(),
                "  ".into(),
                long,
                fit.clone(),
            ],
            ..GitSettings::default()
        }
        .normalized();
        assert_eq!(git.pr_bot_author_overrides, ["alpha", fit.as_str(), "zed"]);

        let many: Vec<String> = (0..BOT_OVERRIDES_MAX + 20)
            .map(|i| format!("b{i:04}"))
            .collect();
        let capped = GitSettings {
            pr_bot_author_overrides: many,
            ..GitSettings::default()
        }
        .normalized();
        assert_eq!(capped.pr_bot_author_overrides.len(), BOT_OVERRIDES_MAX);
    }

    #[test]
    fn an_old_git_section_loads_and_a_wrong_override_type_costs_only_that_field() {
        let old: GitSettings = serde_json::from_str(r#"{ "branchPrefix": "none" }"#).unwrap();
        assert!(old.pr_bot_author_overrides.is_empty());
        assert_eq!(old.recipes.address_comments, Recipe::default());

        let bad: GitSettings = serde_json::from_str(
            r#"{ "branchPrefix": "none", "prBotAuthorOverrides": "oops",
                 "recipes": { "addressComments": 3 } }"#,
        )
        .unwrap();
        assert_eq!(bad.branch_prefix, BranchPrefixMode::None);
        assert!(bad.pr_bot_author_overrides.is_empty());
        assert_eq!(bad.recipes.address_comments, Recipe::default());
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
        let old = Settings {
            last_vault: Some("D:/old".into()),
            ..Settings::default()
        };
        save(&path, &old).unwrap();
        let new = Settings {
            last_vault: Some("D:/new".into()),
            ..Settings::default()
        };
        save(&path, &new).unwrap();
        assert_eq!(load(&path).last_vault.as_deref(), Some("D:/new"));
        // No temp file is left beside it.
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE_NAME]);
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
    fn a_bad_service_field_costs_only_itself() {
        let t: TerminalSettings =
            serde_json::from_str(r#"{ "fontSize": 15, "onQuit": "later", "ringMb": "big" }"#)
                .unwrap();
        assert_eq!(t.font_size, 15);
        assert_eq!(t.on_quit, OnQuit::Keep);
        assert_eq!(t.ring_mb, 2);
        assert!(t.service);
        let ring = |ring_mb| TerminalSettings {
            ring_mb,
            ..TerminalSettings::default()
        };
        assert_eq!(ring(0).clamped().ring_mb, 1);
        assert_eq!(ring(200).clamped().ring_mb, 16);
    }

    #[test]
    fn mac_option_as_alt_defaults_and_survives_bad_values() {
        let old: TerminalSettings = serde_json::from_str(r#"{ "fontSize": 15 }"#).unwrap();
        assert_eq!(old.mac_option_as_alt, MacOptionAsAlt::Auto);
        for bad in [r#""meta""#, "3", "null"] {
            let t: TerminalSettings = serde_json::from_str(&format!(
                r#"{{ "fontSize": 15, "macOptionAsAlt": {bad}, "scrollback": 4000 }}"#
            ))
            .unwrap();
            assert_eq!(t.mac_option_as_alt, MacOptionAsAlt::Auto, "{bad}");
            assert_eq!(t.font_size, 15);
            assert_eq!(t.scrollback, 4000);
        }
        for (value, text) in [
            (MacOptionAsAlt::Auto, "auto"),
            (MacOptionAsAlt::Both, "both"),
            (MacOptionAsAlt::Left, "left"),
            (MacOptionAsAlt::Right, "right"),
            (MacOptionAsAlt::Off, "off"),
        ] {
            let t = TerminalSettings {
                mac_option_as_alt: value,
                ..TerminalSettings::default()
            };
            let json = serde_json::to_string(&t).unwrap();
            assert!(
                json.contains(&format!(r#""macOptionAsAlt":"{text}""#)),
                "{json}"
            );
            let back: TerminalSettings = serde_json::from_str(&json).unwrap();
            assert_eq!(back.mac_option_as_alt, value);
        }
    }

    #[test]
    fn an_old_terminal_file_loads_every_new_field_at_its_default() {
        let t: TerminalSettings = serde_json::from_str(r#"{ "fontSize": 15 }"#).unwrap();
        let want = TerminalSettings {
            font_size: 15,
            ..TerminalSettings::default()
        };
        assert_eq!(t, want);
        assert_eq!(t.theme, "app");
        assert_eq!(t.word_separators, DEFAULT_WORD_SEPARATORS);
    }

    #[test]
    fn a_bad_new_terminal_field_costs_only_itself() {
        let t: TerminalSettings = serde_json::from_str(
            r#"{ "gpu": "fast", "bell": 3, "scrollSensitivity": "x", "theme": 7, "fontSize": 15 }"#,
        )
        .unwrap();
        let want = TerminalSettings {
            font_size: 15,
            ..TerminalSettings::default()
        };
        assert_eq!(t, want);
        // Every other field is also its own.
        let t: TerminalSettings = serde_json::from_str(
            r#"{ "gpu": "on", "bell": "sound", "theme": "nord", "wordSeparators": null,
                 "fastScrollSensitivity": [], "minimumContrast": {}, "focusFollowsMouse": "yes",
                 "scrollSensitivity": 2.0 }"#,
        )
        .unwrap();
        assert_eq!(
            (t.gpu, t.bell, t.theme.as_str()),
            (TerminalGpu::On, TerminalBell::Sound, "nord")
        );
        assert_eq!(t.word_separators, DEFAULT_WORD_SEPARATORS);
        assert_eq!((t.fast_scroll_sensitivity, t.minimum_contrast), (5.0, 1.0));
        assert!(!t.focus_follows_mouse);
        assert_eq!(t.scroll_sensitivity, 2.0);
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
            service: false,
            on_quit: OnQuit::Ask,
            ring_mb: 8,
            theme: "tokyo-night".into(),
            gpu: TerminalGpu::Off,
            bell: TerminalBell::Visual,
            word_separators: " /".into(),
            scroll_sensitivity: 2.5,
            fast_scroll_sensitivity: 8.0,
            minimum_contrast: 4.5,
            focus_follows_mouse: true,
            mac_option_as_alt: MacOptionAsAlt::Left,
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
        assert!(raw.contains("\"onQuit\": \"ask\""), "{raw}");
        assert!(raw.contains("\"ringMb\": 8"), "{raw}");
        for want in [
            "\"theme\": \"tokyo-night\"",
            "\"gpu\": \"off\"",
            "\"bell\": \"visual\"",
            "\"wordSeparators\": \" /\"",
            "\"scrollSensitivity\": 2.5",
            "\"fastScrollSensitivity\": 8.0",
            "\"minimumContrast\": 4.5",
            "\"focusFollowsMouse\": true",
        ] {
            assert!(raw.contains(want), "{want} in {raw}");
        }

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

    fn quick(id: &str, label: &str) -> QuickCommand {
        QuickCommand {
            id: id.into(),
            label: label.into(),
            scope: QuickScope::Global,
            action: QuickAction::Terminal {
                command: "cargo test".into(),
                append_enter: true,
            },
        }
    }

    #[test]
    fn a_file_without_quick_commands_loads_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "version": 1, "last_vault": "D:/docs" }"#).unwrap();
        let loaded = load(&path);
        assert!(loaded.quick_commands.is_empty());
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
    }

    #[test]
    fn quick_commands_round_trip_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let review = QuickCommand {
            id: "qc-2".into(),
            label: "Review".into(),
            scope: QuickScope::Repo {
                repo: "E:/Codes/x".into(),
            },
            action: QuickAction::Agent {
                profile: "claude".into(),
                prompt: "Review the diff
then sum up"
                    .into(),
            },
        };
        let settings = Settings {
            version: VERSION,
            quick_commands: vec![quick("qc-3", "Tests"), review, quick("qc-1", "Lint")],
            ..Settings::default()
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"quickCommands\""), "{raw}");
        assert!(raw.contains("\"appendEnter\": true"), "{raw}");
    }

    #[test]
    fn a_bad_quick_command_drops_only_itself() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let raw = r#"{
            "version": 1,
            "last_vault": "D:/docs",
            "quickCommands": [
                { "id": "qc-1", "label": "Tests", "scope": { "type": "global" },
                  "action": { "type": "terminal", "command": "cargo test" } },
                { "id": "qc-2", "label": "Odd", "scope": { "type": "global" },
                  "action": { "type": "macro", "steps": [] } },
                "not a command",
                { "id": "qc-3", "label": "Lint", "scope": { "type": "global" },
                  "action": { "type": "terminal", "command": "cargo test", "appendEnter": true } }
            ]
        }"#;
        fs::write(&path, raw).unwrap();
        let loaded = load(&path);
        assert_eq!(
            loaded.quick_commands,
            vec![quick("qc-1", "Tests"), quick("qc-3", "Lint")]
        );
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));

        fs::write(&path, r#"{ "version": 1, "quickCommands": { "id": "x" } }"#).unwrap();
        assert!(load(&path).quick_commands.is_empty());
    }

    #[test]
    fn recent_quick_commands_keep_only_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{ "version": 1, "quickCommandsRecent": ["qc-2", 7, "qc-1"] }"#,
        )
        .unwrap();
        assert_eq!(load(&path).quick_commands_recent, ["qc-2", "qc-1"]);
        fs::write(&path, r#"{ "version": 1 }"#).unwrap();
        assert!(load(&path).quick_commands_recent.is_empty());
    }

    #[test]
    fn a_file_without_keys_or_ui_loads_their_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "version": 1, "last_vault": "D:/docs" }"#).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.keys.terminal_policy, TerminalKeyPolicy::AppFirst);
        assert!(loaded.keys.terminal_hints);
        assert_eq!(loaded.ui.zoom, 1.0);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
    }

    #[test]
    fn key_settings_round_trip_and_an_unknown_policy_reads_as_app_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let keys = KeySettings {
            terminal_policy: TerminalKeyPolicy::TerminalFirst,
            terminal_hints: false,
        };
        save(
            &path,
            &Settings {
                keys: keys.clone(),
                ..Settings::default()
            },
        )
        .unwrap();
        assert_eq!(load(&path).keys, keys);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("\"terminalPolicy\": \"terminal-first\""),
            "{raw}"
        );

        fs::write(
            &path,
            r#"{ "keys": { "terminalPolicy": "both", "terminalHints": false }, "ui": { "zoom": "big" } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.keys.terminal_policy, TerminalKeyPolicy::AppFirst);
        assert!(!loaded.keys.terminal_hints);
        assert_eq!(loaded.ui, UiSettings::default());
    }

    #[test]
    fn appearance_defaults_and_an_old_file() {
        let ui = UiSettings::default();
        assert_eq!(ui.ui_font, "");
        assert_eq!(ui.editor_theme_light, EditorTheme::App);
        assert_eq!(ui.editor_theme_dark, EditorTheme::App);
        assert_eq!(ui.sidebar, SidebarLook::Default);
        assert_eq!(ui.status_bar, StatusBarItems::default());
        assert!(ui.status_bar.branch && ui.status_bar.token_usage);
        assert!(ui.status_bar.agents && ui.status_bar.version && ui.status_bar.ports);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{"ui":{"zoom":1.5,"theme":"dark"}}"#).unwrap();
        let ui = load(&path).ui;
        assert_eq!(ui.zoom, 1.5);
        assert_eq!(ui.theme, Theme::Dark);
        assert_eq!(ui.sidebar, SidebarLook::Default);
        assert_eq!(ui.status_bar, StatusBarItems::default());
    }

    #[test]
    fn unknown_appearance_values_fall_back_without_resetting_zoom() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{"ui":{"zoom":1.5,"uiFont":7,"editorThemeLight":"sepia","editorThemeDark":"dark","sidebar":"glass","statusBar":{"branch":"no"}}}"#,
        )
        .unwrap();
        let ui = load(&path).ui;
        assert_eq!(ui.zoom, 1.5);
        assert_eq!(ui.ui_font, "");
        assert_eq!(ui.editor_theme_light, EditorTheme::App);
        assert_eq!(ui.editor_theme_dark, EditorTheme::Dark);
        assert_eq!(ui.sidebar, SidebarLook::Default);
        assert_eq!(ui.status_bar, StatusBarItems::default());

        fs::write(&path, r#"{"ui":{"statusBar":{"agents":false}}}"#).unwrap();
        let bar = load(&path).ui.status_bar;
        assert!(!bar.agents && bar.branch && bar.token_usage && bar.version && bar.ports);
    }

    #[test]
    fn ui_font_is_trimmed_capped_and_free_of_control_characters() {
        let font = |raw: &str| {
            UiSettings {
                ui_font: raw.to_string(),
                ..UiSettings::default()
            }
            .clamped()
            .ui_font
        };
        assert_eq!(font("  Inter  "), "Inter");
        assert_eq!(font("In\u{0}ter\n"), "Inter");
        assert_eq!(font(&"a".repeat(300)).chars().count(), UI_FONT_MAX);
        assert_eq!(font("   "), "");
    }

    #[test]
    fn appearance_round_trips() {
        let ui = UiSettings {
            ui_font: "Inter".into(),
            editor_theme_light: EditorTheme::Dark,
            editor_theme_dark: EditorTheme::Light,
            sidebar: SidebarLook::Tinted,
            status_bar: StatusBarItems {
                version: false,
                ..StatusBarItems::default()
            },
            ..UiSettings::default()
        };
        let json = serde_json::to_string(&ui).unwrap();
        assert!(json.contains("\"editorThemeLight\":\"dark\""));
        assert!(json.contains("\"tokenUsage\":true"));
        assert_eq!(serde_json::from_str::<UiSettings>(&json).unwrap(), ui);
    }

    #[test]
    fn zoom_clamps_to_its_range() {
        let at = |zoom: f32| {
            UiSettings {
                zoom,
                ..UiSettings::default()
            }
            .clamped()
            .zoom
        };
        assert_eq!(at(0.1), 0.5);
        assert_eq!(at(3.0), 2.0);
        assert_eq!(at(1.25), 1.25);
        assert_eq!(at(f32::NAN), 1.0);
        assert_eq!(at(f32::INFINITY), 1.0);
    }

    #[test]
    fn a_file_without_restore_loads_all() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            format!(r#"{{"version":{VERSION},"ui":{{"zoom":1.5}}}}"#),
        )
        .unwrap();
        let ui = load(&path).ui;
        assert_eq!(ui.zoom, 1.5);
        assert_eq!(ui.restore, RestoreMode::All);
    }

    #[test]
    fn a_file_without_theme_loads_system() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{"ui":{"zoom":1.5,"restore":"none"}}"#).unwrap();
        let ui = load(&path).ui;
        assert_eq!(ui.theme, Theme::System);
        assert_eq!(ui.zoom, 1.5);
        assert_eq!(ui.restore, RestoreMode::None);

        fs::write(&path, r#"{"ui":{"zoom":1.5,"theme":"sepia"}}"#).unwrap();
        let ui = load(&path).ui;
        assert_eq!(ui.theme, Theme::System);
        assert_eq!(ui.zoom, 1.5);
    }

    #[test]
    fn each_theme_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        for (theme, text) in [
            (Theme::System, "system"),
            (Theme::Dark, "dark"),
            (Theme::Light, "light"),
        ] {
            let settings = Settings {
                ui: UiSettings {
                    theme,
                    ..UiSettings::default()
                },
                ..Settings::default()
            };
            save(&path, &settings).unwrap();
            let json: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(json["ui"]["theme"], text);
            assert_eq!(load(&path).ui, settings.ui);
        }
    }

    #[test]
    fn each_restore_mode_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        for (mode, text) in [
            (RestoreMode::All, "all"),
            (RestoreMode::AgentsOnly, "agentsOnly"),
            (RestoreMode::None, "none"),
        ] {
            let settings = Settings {
                ui: UiSettings {
                    zoom: 1.25,
                    restore: mode,
                    ..UiSettings::default()
                },
                ..Settings::default()
            };
            save(&path, &settings).unwrap();
            let json: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(json["ui"]["restore"], text);
            assert_eq!(load(&path).ui, settings.ui);
        }
    }

    #[test]
    fn an_unknown_restore_mode_reads_all_and_keeps_the_zoom() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        for restore in [r#""sometimes""#, "3", "null"] {
            let text =
                format!(r#"{{"version":{VERSION},"ui":{{"zoom":1.5,"restore":{restore}}}}}"#);
            fs::write(&path, text).unwrap();
            let ui = load(&path).ui;
            assert_eq!(ui.zoom, 1.5, "{restore}");
            assert_eq!(ui.restore, RestoreMode::All, "{restore}");
        }
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

    #[test]
    fn terminal_theme_and_word_separators_are_normalised() {
        let with = |theme: &str, words: &str| {
            TerminalSettings {
                theme: theme.into(),
                word_separators: words.into(),
                ..TerminalSettings::default()
            }
            .clamped()
        };
        for bad in ["Dracula", "../x", "", "a b", &"a".repeat(41)] {
            assert_eq!(with(bad, " ").theme, THEME_APP, "{bad:?}");
        }
        for ok in ["tokyo-night", "app", "a", &"a".repeat(40)] {
            assert_eq!(with(ok, " ").theme, ok);
        }
        // Control chars dropped, the rest kept in order.
        assert_eq!(with("app", " a\u{7}/\n\t").word_separators, " a/");
        // Cut to 64 chars (not bytes).
        assert_eq!(
            with("app", &"é".repeat(100))
                .word_separators
                .chars()
                .count(),
            64
        );
        assert_eq!(with("app", &"-".repeat(64)).word_separators, "-".repeat(64));
        // Empty, or only control chars: the default.
        for empty in ["", "\u{1}\n"] {
            assert_eq!(with("app", empty).word_separators, DEFAULT_WORD_SEPARATORS);
        }
    }

    #[test]
    fn terminal_new_numbers_clamp_and_nan_reads_as_the_default() {
        let with = |scroll, fast, contrast| {
            TerminalSettings {
                scroll_sensitivity: scroll,
                fast_scroll_sensitivity: fast,
                minimum_contrast: contrast,
                ..TerminalSettings::default()
            }
            .clamped()
        };
        let hi = with(99.0, 99.0, 99.0);
        assert_eq!(
            (
                hi.scroll_sensitivity,
                hi.fast_scroll_sensitivity,
                hi.minimum_contrast
            ),
            (3.0, 10.0, 21.0)
        );
        let lo = with(0.0, 0.0, 0.0);
        assert_eq!(
            (
                lo.scroll_sensitivity,
                lo.fast_scroll_sensitivity,
                lo.minimum_contrast
            ),
            (0.5, 1.0, 1.0)
        );
        let nan = with(f32::NAN, f32::NAN, f32::NAN);
        assert_eq!(
            (
                nan.scroll_sensitivity,
                nan.fast_scroll_sensitivity,
                nan.minimum_contrast
            ),
            (1.15, 5.0, 1.0)
        );
        let inf = with(f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY);
        assert_eq!(
            (
                inf.scroll_sensitivity,
                inf.fast_scroll_sensitivity,
                inf.minimum_contrast
            ),
            (1.15, 5.0, 1.0)
        );
        // In range: untouched.
        let fine = TerminalSettings {
            theme: "nord".into(),
            word_separators: " /.".into(),
            scroll_sensitivity: 2.0,
            fast_scroll_sensitivity: 7.5,
            minimum_contrast: 4.5,
            ..TerminalSettings::default()
        };
        assert_eq!(fine.clone().clamped(), fine);
        assert_eq!(
            TerminalSettings::default().clamped(),
            TerminalSettings::default()
        );
    }

    #[test]
    fn editor_settings_round_trip_and_an_old_file_loads_their_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let editor = EditorSettings {
            autosave: true,
            autosave_ms: 2500,
            font_size: 15,
            font_family: String::new(),
            word_wrap: true,
            tab_size: 2,
        };
        save(
            &path,
            &Settings {
                editor: editor.clone(),
                ..Settings::default()
            },
        )
        .unwrap();
        assert_eq!(load(&path).editor, editor);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"autosaveMs\": 2500"), "{raw}");

        fs::write(&path, r#"{ "version": 1, "last_vault": "D:/docs" }"#).unwrap();
        assert_eq!(load(&path).editor, EditorSettings::default());
        // A broken section loads its defaults and keeps the rest.
        fs::write(
            &path,
            r#"{ "editor": { "tabSize": "wide" }, "ui": { "zoom": 1.5 } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.editor, EditorSettings::default());
        assert_eq!(loaded.ui.zoom, 1.5);
    }

    #[test]
    fn sidebar_layout_has_its_defaults_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "sidebar": { "hideCli": true } }"#).unwrap();
        let sb = load(&path).sidebar;
        assert!(sb.hide_cli);
        assert_eq!(sb.group_by, SidebarGroupBy::Activity);
        assert_eq!(sb.sort, SidebarSort::Manual);
        assert!(!sb.compact_cards);
        assert_eq!(sb.card, CardProps::default());
        assert!(sb.card.branch && sb.card.project_chip);

        let want = SidebarPrefs {
            group_by: SidebarGroupBy::Project,
            sort: SidebarSort::Recent,
            compact_cards: true,
            card: CardProps {
                time: false,
                pr: false,
                ..CardProps::default()
            },
            ..SidebarPrefs::default()
        };
        let text = serde_json::to_string(&want).unwrap();
        assert!(text.contains(r#""groupBy":"project""#));
        let back: SidebarPrefs = serde_json::from_str(&text).unwrap();
        assert_eq!(back, want);
    }

    #[test]
    fn lineage_sort_fields_default_and_round_trip() {
        let sb: SidebarPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(sb.project_order, ProjectOrder::Manual);
        assert!(!sb.pinned_in_groups);
        assert!(sb.card.ports);
        let nav: NavigationSettings = serde_json::from_str("{}").unwrap();
        assert!(!nav.always_force_delete_worktrees && !nav.always_delete_kept_branches);
        for (text, want) in [
            ("name", SidebarSort::Name),
            ("smart", SidebarSort::Smart),
            ("project", SidebarSort::Project),
        ] {
            let sb: SidebarPrefs =
                serde_json::from_str(&format!(r#"{{"sort":"{text}"}}"#)).unwrap();
            assert_eq!(sb.sort, want);
            assert!(
                serde_json::to_string(&sb)
                    .unwrap()
                    .contains(&format!(r#""sort":"{text}""#))
            );
        }
        let sb: SidebarPrefs =
            serde_json::from_str(r#"{"projectOrder":"recent","pinnedInGroups":true}"#).unwrap();
        assert_eq!(sb.project_order, ProjectOrder::Recent);
        assert!(sb.pinned_in_groups);
        let sb: SidebarPrefs = serde_json::from_str(r#"{"projectOrder":"x","sort":"y"}"#).unwrap();
        assert_eq!(sb.project_order, ProjectOrder::Manual);
        assert_eq!(sb.sort, SidebarSort::Manual);
    }

    #[test]
    fn an_unknown_sidebar_group_or_sort_is_the_default() {
        let sb: SidebarPrefs =
            serde_json::from_str(r#"{ "groupBy": "bogus", "sort": 3, "compactCards": true }"#)
                .unwrap();
        assert_eq!(sb.group_by, SidebarGroupBy::Activity);
        assert_eq!(sb.sort, SidebarSort::Manual);
        assert!(sb.compact_cards);
    }

    #[test]
    fn source_control_group_order_defaults_and_round_trips() {
        let git: GitSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(
            git.source_control_group_order,
            SourceControlGroupOrder::ChangesFirst
        );
        let git: GitSettings =
            serde_json::from_str(r#"{ "sourceControlGroupOrder": "staged-first" }"#).unwrap();
        assert_eq!(
            git.source_control_group_order,
            SourceControlGroupOrder::StagedFirst
        );
        let text = serde_json::to_string(&git).unwrap();
        assert!(text.contains(r#""sourceControlGroupOrder":"staged-first""#));
        let bad: GitSettings =
            serde_json::from_str(r#"{ "sourceControlGroupOrder": "x" }"#).unwrap();
        assert_eq!(
            bad.source_control_group_order,
            SourceControlGroupOrder::ChangesFirst
        );
    }

    #[test]
    fn pull_policy_defaults_to_ff_only_and_round_trips() {
        let git: GitSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(git.pull_policy, PullPolicy::FfOnly);
        for (text, want) in [
            ("ff-only", PullPolicy::FfOnly),
            ("merge", PullPolicy::Merge),
            ("rebase", PullPolicy::Rebase),
            ("git-config", PullPolicy::GitConfig),
        ] {
            let git: GitSettings =
                serde_json::from_str(&format!(r#"{{ "pullPolicy": "{text}" }}"#)).unwrap();
            assert_eq!(git.pull_policy, want);
            let out = serde_json::to_string(&git).unwrap();
            assert!(out.contains(&format!(r#""pullPolicy":"{text}""#)), "{out}");
        }
        let bad: GitSettings = serde_json::from_str(r#"{ "pullPolicy": "x" }"#).unwrap();
        assert_eq!(bad.pull_policy, PullPolicy::FfOnly);
        let num: GitSettings = serde_json::from_str(r#"{ "pullPolicy": 3 }"#).unwrap();
        assert_eq!(num.pull_policy, PullPolicy::FfOnly);
    }

    #[test]
    fn navigation_and_diff_have_their_defaults() {
        let s = Settings::default();
        assert_eq!(s.navigation.tab_order, TabOrder::Mru);
        assert!(s.navigation.confirm_close_pinned);
        assert!(s.navigation.confirm_close_running);
        assert!(s.navigation.ask_before_delete_worktree);
        assert_eq!(s.diff.default_view, DiffView::Inline);
        assert!(!s.diff.ignore_whitespace);
        assert!(s.diff.collapse_unchanged);
        assert!(!s.diff.word_wrap);
        assert!(!s.diff.file_tree);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{ "version": 1 }"#).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.navigation, NavigationSettings::default());
        assert_eq!(loaded.diff, DiffSettings::default());
    }

    #[test]
    fn a_bad_navigation_field_keeps_the_rest_of_the_section() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{ "navigation": { "tabOrder": "bogus", "confirmClosePinned": false } }"#,
        )
        .unwrap();
        let nav = load(&path).navigation;
        assert!(!nav.confirm_close_pinned);
        assert_eq!(nav.tab_order, TabOrder::Mru);
        assert!(nav.confirm_close_running);
    }

    #[test]
    fn agents_settings_default_to_ask_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        // Missing section, missing key, an unknown value, a wrong type.
        for text in [
            "{}",
            r#"{ "agents": {} }"#,
            r#"{ "agents": { "accountSwitch": "bogus" } }"#,
            r#"{ "agents": 3 }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(
                load(&path).agents.account_switch,
                SwitchRunning::Ask,
                "{text}"
            );
        }
        for (value, json) in [
            (SwitchRunning::Ask, "ask"),
            (SwitchRunning::Restart, "restart"),
            (SwitchRunning::Keep, "keep"),
        ] {
            let agents = AgentsSettings {
                account_switch: value,
                ..AgentsSettings::default()
            };
            assert_eq!(
                serde_json::to_value(&agents).unwrap(),
                serde_json::json!({
                    "accountSwitch": json,
                    "keepAwake": "off",
                    "autoTabTitle": false,
                    "autoSleep": false,
                    "sleepAfterMin": 30,
                    "sessionSearch": false
                })
            );
            fs::write(
                &path,
                format!(r#"{{ "agents": {{ "accountSwitch": "{json}" }} }}"#),
            )
            .unwrap();
            assert_eq!(load(&path).agents, agents);
        }
        // The two newer fields default, round trip and stay lenient.
        let defaults = AgentsSettings::default();
        assert_eq!(defaults.keep_awake, KeepAwake::Off);
        assert!(!defaults.auto_tab_title);
        for (value, json) in [
            (KeepAwake::On, "on"),
            (KeepAwake::Agent, "agent"),
            (KeepAwake::Off, "off"),
        ] {
            let agents = AgentsSettings {
                keep_awake: value,
                auto_tab_title: true,
                ..AgentsSettings::default()
            };
            let text = serde_json::to_string(&serde_json::json!({ "agents": agents })).unwrap();
            assert!(text.contains(&format!(r#""keepAwake":"{json}""#)));
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).agents, agents);
        }
        fs::write(
            &path,
            r#"{ "agents": { "accountSwitch": "keep", "keepAwake": "bogus", "autoTabTitle": 3 } }"#,
        )
        .unwrap();
        let loaded = load(&path).agents;
        assert_eq!(loaded.keep_awake, KeepAwake::Off);
        assert!(!loaded.auto_tab_title);
        assert_eq!(loaded.account_switch, SwitchRunning::Keep);
        let on = AgentsSettings {
            auto_sleep: true,
            sleep_after_min: 5,
            session_search: true,
            ..AgentsSettings::default()
        };
        fs::write(&path, serde_json::json!({ "agents": on }).to_string()).unwrap();
        assert_eq!(load(&path).agents, on);
    }

    #[test]
    fn sleep_after_min_is_clamped() {
        for (given, want) in [(0, 1), (1, 1), (45, 45), (1440, 1440), (99_999, 1440)] {
            let s = AgentsSettings {
                sleep_after_min: given,
                ..AgentsSettings::default()
            };
            assert_eq!(s.clamped().sleep_after_min, want);
        }
    }

    #[test]
    fn the_xdev_id_server_setting_defaults_to_empty_and_stays_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        for text in [
            "{}",
            r#"{ "xdevId": {} }"#,
            r#"{ "xdevId": 3 }"#,
            r#"{ "xdevId": { "server": 4 } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).xdev_id.server, "", "{text}");
        }
        fs::write(
            &path,
            r#"{ "xdevId": { "server": "https://id.corp.test" }, "usage": 1 }"#,
        )
        .unwrap();
        assert_eq!(load(&path).xdev_id.server, "https://id.corp.test");
    }

    #[test]
    fn orchestration_settings_default_and_stay_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let want = OrchestrationSettings::default();
        assert_eq!(want.nested_worker_max_depth, 1);
        assert!(want.worker_auto_close);
        for text in [
            "{}",
            r#"{ "orchestration": {} }"#,
            r#"{ "orchestration": 3 }"#,
            r#"{ "orchestration": { "nestedWorkerMaxDepth": "deep" } }"#,
            r#"{ "orchestration": { "workerAutoClose": 7 } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).orchestration, want, "{text}");
        }
        // A broken section keeps the other sections.
        fs::write(
            &path,
            r#"{ "orchestration": [1], "agents": { "accountSwitch": "keep" } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.orchestration, want);
        assert_eq!(loaded.agents.account_switch, SwitchRunning::Keep);
        fs::write(
            &path,
            r#"{ "orchestration": { "nestedWorkerMaxDepth": 3, "workerAutoClose": false } }"#,
        )
        .unwrap();
        let got = load(&path).orchestration;
        assert_eq!(got.nested_worker_max_depth, 3);
        assert!(!got.worker_auto_close);
    }

    #[test]
    fn orchestration_depth_is_clamped_to_one_through_nine() {
        let depth = |n: u32| {
            OrchestrationSettings {
                nested_worker_max_depth: n,
                worker_auto_close: true,
            }
            .normalized()
            .nested_worker_max_depth
        };
        assert_eq!(depth(0), 1);
        assert_eq!(depth(1), 1);
        assert_eq!(depth(5), 5);
        assert_eq!(depth(9), 9);
        assert_eq!(depth(10), 9);
        assert_eq!(depth(u32::MAX), 9);
    }

    #[test]
    fn usage_settings_default_and_stay_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let want = UsageSettings::default();
        assert_eq!(want.display, UsageDisplay::Used);
        assert!(want.footer.claude && want.footer.codex);
        assert!(!want.scan.claude && !want.scan.codex);
        assert!(!want.cache_timer);
        assert_eq!(want.cache_ttl_ms, CACHE_TTL_SHORT_MS);
        for text in [
            "{}",
            r#"{ "usage": {} }"#,
            r#"{ "usage": 3 }"#,
            r#"{ "usage": { "display": "bogus" } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).usage, want, "{text}");
        }
        // A broken usage section keeps the other sections.
        fs::write(
            &path,
            r#"{ "usage": [1], "agents": { "accountSwitch": "keep" } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.usage, want);
        assert_eq!(loaded.agents.account_switch, SwitchRunning::Keep);
    }

    #[test]
    fn usage_settings_round_trip_and_normalise_the_cache_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let usage = UsageSettings {
            display: UsageDisplay::Remaining,
            footer: ProviderSwitches {
                claude: true,
                codex: false,
            },
            scan: ProviderSwitches {
                claude: true,
                codex: false,
            },
            cache_timer: true,
            cache_ttl_ms: CACHE_TTL_LONG_MS,
        };
        let json = serde_json::to_value(&usage).unwrap();
        assert_eq!(json["display"], "remaining");
        assert_eq!(json["cacheTtlMs"], 3_600_000);
        fs::write(&path, format!(r#"{{ "usage": {json} }}"#)).unwrap();
        assert_eq!(load(&path).usage, usage);

        let odd = UsageSettings {
            cache_ttl_ms: 12345,
            ..UsageSettings::default()
        };
        assert_eq!(odd.normalized().cache_ttl_ms, CACHE_TTL_SHORT_MS);
        assert_eq!(usage.clone().normalized(), usage);
    }

    #[test]
    fn shell_settings_default_and_stay_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let want = ShellSettings::default();
        assert!(!want.minimize_to_tray);
        assert!(want.menu_bar_icon);
        assert!(!want.tray_notice_shown);
        assert_eq!(want.update_channel, UpdateChannel::Stable);
        for text in [
            "{}",
            r#"{ "shell": {} }"#,
            r#"{ "shell": 3 }"#,
            r#"{ "shell": { "updateChannel": "nightly" } }"#,
            r#"{ "shell": { "updateChannel": 7 } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).shell, want, "{text}");
        }
        // A broken shell section keeps the other sections.
        fs::write(
            &path,
            r#"{ "shell": [1], "agents": { "accountSwitch": "keep" } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.shell, want);
        assert_eq!(loaded.agents.account_switch, SwitchRunning::Keep);
    }

    #[test]
    fn shell_settings_round_trip_with_camel_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let shell = ShellSettings {
            minimize_to_tray: true,
            menu_bar_icon: false,
            tray_notice_shown: true,
            update_channel: UpdateChannel::Rc,
        };
        let json = serde_json::to_value(&shell).unwrap();
        assert_eq!(json["minimizeToTray"], true);
        assert_eq!(json["menuBarIcon"], false);
        assert_eq!(json["trayNoticeShown"], true);
        assert_eq!(json["updateChannel"], "rc");
        fs::write(&path, format!(r#"{{ "shell": {json} }}"#)).unwrap();
        assert_eq!(load(&path).shell, shell);
    }

    #[test]
    fn a_shell_put_keeps_the_stored_notice_flag() {
        let stored = ShellSettings {
            tray_notice_shown: true,
            ..ShellSettings::default()
        };
        let incoming = ShellSettings {
            minimize_to_tray: true,
            tray_notice_shown: false,
            ..ShellSettings::default()
        };
        let put = incoming.for_put(&stored);
        assert!(put.tray_notice_shown);
        assert!(put.minimize_to_tray);
        assert!(
            !ShellSettings::default()
                .for_put(&ShellSettings::default())
                .tray_notice_shown
        );
    }

    #[test]
    fn navigation_and_diff_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let navigation = NavigationSettings {
            tab_order: TabOrder::Sequential,
            confirm_close_pinned: false,
            confirm_close_running: false,
            ask_before_delete_worktree: false,
            always_force_delete_worktrees: true,
            always_delete_kept_branches: true,
        };
        let diff = DiffSettings {
            default_view: DiffView::Split,
            ignore_whitespace: true,
            collapse_unchanged: false,
            word_wrap: true,
            file_tree: true,
        };
        save(
            &path,
            &Settings {
                navigation: navigation.clone(),
                diff: diff.clone(),
                ..Settings::default()
            },
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.navigation, navigation);
        assert_eq!(loaded.diff, diff);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"tabOrder\": \"sequential\""), "{raw}");
        assert!(raw.contains("\"defaultView\": \"split\""), "{raw}");
    }

    #[test]
    fn editor_clamps_to_its_ranges() {
        let wild = EditorSettings {
            autosave_ms: 0,
            font_size: 200,
            tab_size: 0,
            ..EditorSettings::default()
        }
        .clamped();
        assert_eq!(
            (wild.autosave_ms, wild.font_size, wild.tab_size),
            (250, 32, 1)
        );
        let high = EditorSettings {
            autosave_ms: u32::MAX,
            font_size: 1,
            tab_size: 99,
            ..EditorSettings::default()
        }
        .clamped();
        assert_eq!(
            (high.autosave_ms, high.font_size, high.tab_size),
            (10_000, 8, 8)
        );
        let fine = EditorSettings {
            autosave: true,
            autosave_ms: 250,
            font_size: 32,
            font_family: "Fira Code".into(),
            word_wrap: true,
            tab_size: 8,
        };
        assert_eq!(fine.clone().clamped(), fine);
    }

    #[test]
    fn editor_font_family_is_cleaned() {
        let s = EditorSettings {
            font_family: "  Fira\u{7} Code  ".into(),
            ..EditorSettings::default()
        }
        .clamped();
        assert_eq!(s.font_family, "Fira Code");
        assert_eq!(EditorSettings::default().font_family, "");
    }

    #[test]
    fn word_wrap_defaults_on() {
        assert!(EditorSettings::default().word_wrap);
        let s: EditorSettings = serde_json::from_str(r#"{ "tabSize": 2 }"#).unwrap();
        assert!(s.word_wrap);
    }

    #[test]
    fn a_stored_false_wrap_stays_false() {
        let s: EditorSettings = serde_json::from_str(r#"{ "wordWrap": false }"#).unwrap();
        assert!(!s.word_wrap);
    }

    /// `EDITOR_DEFAULTS` and `EDITOR_LIMITS` in the UI match Rust.
    #[test]
    fn editor_defaults_match_the_ui() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let rust = serde_json::to_value(EditorSettings::default()).unwrap();
        let rust = rust.as_object().unwrap();
        // Built in memory: reading `packages/bindings` races `export_bindings`,
        // which clears that folder while the tests run in parallel.
        let binding =
            <EditorSettings as ts_rs::TS>::decl(&ts_rs::Config::new().with_large_int("number"));
        for key in rust.keys() {
            assert!(binding.contains(&format!("{key}: ")), "binding lacks {key}");
        }

        let ui = fs::read_to_string(root.join("apps/desktop/src/files/editorDefaults.ts")).unwrap();
        let body = ui
            .split_once("EDITOR_DEFAULTS: EditorSettings = {")
            .and_then(|(_, rest)| rest.split_once("};"))
            .map(|(body, _)| body)
            .expect("EDITOR_DEFAULTS literal");
        let mut seen = Vec::new();
        for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let (key, value) = line
                .trim_end_matches(',')
                .split_once(": ")
                .unwrap_or_else(|| panic!("{line}"));
            let got: serde_json::Value = serde_json::from_str(value).unwrap();
            assert_eq!(Some(&got), rust.get(key), "{key}");
            seen.push(key.to_owned());
        }
        seen.sort();
        let mut keys: Vec<_> = rust.keys().cloned().collect();
        keys.sort();
        assert_eq!(seen, keys);

        for (key, range) in [
            ("autosaveMs", EditorSettings::AUTOSAVE_MS),
            ("fontSize", EditorSettings::FONT_SIZE),
            ("tabSize", EditorSettings::TAB_SIZE),
        ] {
            let want = format!("{key}: {{ min: {}, max: {} }}", range.start(), range.end());
            assert!(ui.contains(&want), "UI lacks {want}");
        }
    }

    /// `TERMINAL_DEFAULTS` in the UI and the generated binding name the same
    /// fields as Rust, with the same default values.
    #[test]
    fn terminal_defaults_match_the_ui() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let rust = serde_json::to_value(TerminalSettings::default()).unwrap();
        let rust = rust.as_object().unwrap();

        // The declaration ts-rs writes to `packages/bindings`, built in memory: reading the file
        // races `export_bindings`, which clears that folder while the tests run in parallel.
        let binding =
            <TerminalSettings as ts_rs::TS>::decl(&ts_rs::Config::new().with_large_int("number"));
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
