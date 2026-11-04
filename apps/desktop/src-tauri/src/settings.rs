use std::fs;
use std::io;
use std::ops::RangeInclusive;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::atomic::write_atomic;
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
}

/// Which worktree rows the sidebar hides. All off: every row shows.
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
}

impl Default for NavigationSettings {
    fn default() -> Self {
        NavigationSettings {
            tab_order: TabOrder::default(),
            confirm_close_pinned: true,
            confirm_close_running: true,
            ask_before_delete_worktree: true,
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
            word_wrap: false,
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
}

impl Default for UiSettings {
    fn default() -> Self {
        UiSettings {
            zoom: 1.0,
            restore: RestoreMode::All,
        }
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
        self
    }
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
    Keys,
    Ui,
    /// `quickCommands` and their recently used order.
    QuickCommands,
    OpenIn,
    Editor,
    Sidebar,
    Navigation,
    Diff,
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
        }
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
            recipes: GitRecipes::default(),
        }
    }
}

impl GitSettings {
    /// As stored: the custom prefix normalized the way names use it.
    pub fn normalized(mut self) -> GitSettings {
        self.branch_prefix_custom = xdev_workspace::normalize_prefix(&self.branch_prefix_custom);
        self.recipes = self.recipes.normalized();
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
    fn editor_settings_round_trip_and_an_old_file_loads_their_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let editor = EditorSettings {
            autosave: true,
            autosave_ms: 2500,
            font_size: 15,
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
    fn navigation_and_diff_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let navigation = NavigationSettings {
            tab_order: TabOrder::Sequential,
            confirm_close_pinned: false,
            confirm_close_running: false,
            ask_before_delete_worktree: false,
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
            word_wrap: true,
            tab_size: 8,
        };
        assert_eq!(fine.clone().clamped(), fine);
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
