use crate::applog;
use std::fs;
use std::io;
use std::ops::RangeInclusive;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::atomic::write_atomic;
use xdev_git::PullPolicy;

use crate::quick_commands::QuickCommand;
use crate::terminal_sets::{StartupPreset, TerminalSet};

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
    #[serde(default, deserialize_with = "lenient_status")]
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
    /// Saved terminal sets, in the order they were made; a bad entry is
    /// dropped on its own.
    #[serde(default, rename = "terminalSets", deserialize_with = "lenient_items")]
    pub terminal_sets: Vec<TerminalSet>,
    /// Saved startup sequences; lenient the same way.
    #[serde(default, rename = "startupPresets", deserialize_with = "lenient_items")]
    pub startup_presets: Vec<StartupPreset>,
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
    /// Settings → Automations; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub automations: AutomationsSettings,
    /// Settings → Advanced: proxy, bypass list, package mirror and machine
    /// name; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub network: NetworkSettings,
    /// Settings → Paired computers: the encrypted link listener; lenient the
    /// same way.
    #[serde(default, deserialize_with = "lenient")]
    pub link: LinkSettings,
    /// Settings → Cloud: the license server and its trusted keys; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub cloud: CloudSettings,
    /// Settings → Screenshots; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub capture: CaptureSettings,
    /// Settings → Browser; lenient the same way.
    #[serde(default, deserialize_with = "lenient")]
    pub browser: BrowserSettings,
    /// Settings → Voice; lenient the same way. The OpenAI key is not here:
    /// it lives in the OS keychain only.
    #[serde(default, deserialize_with = "lenient")]
    pub speech: SpeechSettings,
}

/// Settings → Cloud: which xDev ID server the license talks to, and the keys its tokens are
/// trusted under. Changing the server signs out of xDev ID and drops `license.json`.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct CloudSettings {
    /// A self-hosted server's origin. `None`: the official service.
    pub server_url: Option<String>,
    /// base64url raw 32-byte Ed25519 root keys. Used only with a custom server.
    pub pinned_roots: Vec<String>,
}

impl CloudSettings {
    /// What the store may hold: `https://` (or `http://localhost` when `allow_http`), roots that
    /// are 32-byte base64url keys, and at least one root for a custom server. Returns the
    /// normalised value: trimmed, empty as `None`, roots de-duplicated.
    pub fn checked(&self, allow_http: bool) -> Result<CloudSettings, &'static str> {
        let raw = self.server_url.as_deref().map(str::trim).unwrap_or("");
        let server_url = if raw.is_empty() {
            None
        } else {
            let origin = xdev_id::check_origin(raw).ok_or("cloud_bad_url")?;
            if origin.starts_with("http://") && !allow_http {
                return Err("cloud_bad_url");
            }
            (origin != xdev_license::cloud::DEFAULT_SERVER).then_some(origin)
        };
        let mut pinned_roots: Vec<String> = Vec::new();
        for root in &self.pinned_roots {
            let root = root.trim();
            if root.is_empty() {
                continue;
            }
            if xdev_license::b64::decode_32(root).is_none() {
                return Err("cloud_bad_root");
            }
            if !pinned_roots.iter().any(|r| r == root) {
                pinned_roots.push(root.to_owned());
            }
        }
        if server_url.is_none() {
            pinned_roots.clear();
        } else if pinned_roots.is_empty() {
            return Err("cloud_need_root");
        }
        Ok(CloudSettings {
            server_url,
            pinned_roots,
        })
    }

    pub fn config(&self) -> xdev_license::cloud::CloudConfig {
        xdev_license::cloud::CloudConfig {
            server_url: self
                .server_url
                .clone()
                .unwrap_or_else(|| xdev_license::cloud::DEFAULT_SERVER.to_owned()),
            pinned_roots: self.pinned_roots.clone(),
        }
    }
}

/// The port the link listener tries first.
pub const LINK_PORT: u16 = 47821;

/// Settings → Paired computers. Changing `enabled` or `bind` restarts the
/// listener.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct LinkSettings {
    /// Off until the person turns it on: nothing listens before that.
    pub enabled: bool,
    pub bind: xdev_link::LinkBind,
    pub port: u16,
    /// Ask on this computer before every action a paired computer takes.
    pub confirm_each: bool,
}

impl Default for LinkSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: xdev_link::LinkBind::Localhost,
            port: LINK_PORT,
            confirm_each: false,
        }
    }
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct OrchestrationSettings {
    /// How many generations of dispatched workers may start workers of their
    /// own; 1 keeps the agent tree flat.
    pub nested_worker_max_depth: u32,
    /// Close a worker's tab 2 minutes after it finishes.
    pub worker_auto_close: bool,
    /// Replace a worker that fails before it finishes.
    pub failover_enabled: bool,
    /// Try the same agent on another account of its provider first.
    pub failover_backup_account: bool,
    /// Agent profiles to try next, in order.
    pub failover_backup_agents: Vec<String>,
    /// Failovers one dispatch may make.
    pub failover_max: u32,
    /// Restart a stuck worker once, then fail it over.
    pub autopilot_restart: bool,
    /// Minutes a busy worker may go without output before it counts as stuck.
    pub stuck_minutes: u32,
}

/// The most failovers one dispatch may make.
pub const FAILOVER_MAX: u32 = 5;
/// The most backup agents the list keeps.
pub const BACKUP_AGENTS_MAX: usize = 8;
/// The longest a busy worker may go quiet before it counts as stuck.
pub const STUCK_MINUTES_MAX: u32 = 120;

impl Default for OrchestrationSettings {
    fn default() -> Self {
        Self {
            nested_worker_max_depth: 1,
            worker_auto_close: true,
            failover_enabled: false,
            failover_backup_account: true,
            failover_backup_agents: Vec::new(),
            failover_max: xdev_orch::failover::DEFAULT_MAX_FAILOVERS,
            autopilot_restart: false,
            stuck_minutes: 10,
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
    /// A newer release is offered once it is this many days old; one of
    /// [`UPDATE_DELAY_DAYS`], 0 offers it at once.
    #[serde(deserialize_with = "lenient_delay")]
    pub update_delay_days: u8,
    /// macOS only: the agent status strip at the notch; off unless turned on.
    pub notch_status: bool,
}

/// The delays the Updates setting offers, in days.
pub const UPDATE_DELAY_DAYS: [u8; 4] = [0, 1, 3, 7];

/// The allowed delay nearest to `days`; halfway between two is the shorter one.
pub fn nearest_update_delay(days: i64) -> u8 {
    UPDATE_DELAY_DAYS
        .into_iter()
        .min_by_key(|d| (i64::from(*d) - days).abs())
        .unwrap_or(0)
}

/// A stored delay that is not a number reads as 0; any number is clamped.
fn lenient_delay<'de, D: serde::Deserializer<'de>>(de: D) -> Result<u8, D::Error> {
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    Ok(match value.as_i64() {
        Some(days) => nearest_update_delay(days),
        // Above `i64::MAX`, or a fraction.
        None => value
            .as_f64()
            .map_or(0, |f| nearest_update_delay(f.round() as i64)),
    })
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            minimize_to_tray: false,
            menu_bar_icon: true,
            tray_notice_shown: false,
            update_channel: UpdateChannel::Stable,
            update_delay_days: 0,
            notch_status: false,
        }
    }
}

impl OrchestrationSettings {
    /// What `orchestration_settings_put` stores: the depth clamped to 1..=9,
    /// the failover count to 0..=5, the stuck time to 1..=120 minutes, and
    /// the backup agents trimmed, without blanks or repeats, at most 8.
    pub fn normalized(mut self) -> Self {
        self.nested_worker_max_depth = self.nested_worker_max_depth.clamp(1, NESTED_DEPTH_MAX);
        self.failover_max = self.failover_max.min(FAILOVER_MAX);
        self.stuck_minutes = self.stuck_minutes.clamp(1, STUCK_MINUTES_MAX);
        let mut agents: Vec<String> = Vec::new();
        for a in self.failover_backup_agents.iter().map(|a| a.trim()) {
            if !a.is_empty() && !agents.iter().any(|b| b == a) && agents.len() < BACKUP_AGENTS_MAX {
                agents.push(a.to_owned());
            }
        }
        self.failover_backup_agents = agents;
        self
    }
}

/// The Pro feature the `rc` update channel needs.
pub const EARLY_FEATURE: &str = "pro.early";

/// Whether the channel may change from `stored` to `next`. Choosing `rc` needs `pro_early`, except
/// where the stored value is already `rc` (grandfathered: that person keeps it). `stable` is always
/// allowed. The error is `license_required`.
pub fn check_channel(
    stored: UpdateChannel,
    next: UpdateChannel,
    pro_early: bool,
) -> Result<(), crate::commands::CmdError> {
    if next == UpdateChannel::Rc && stored != UpdateChannel::Rc && !pro_early {
        return Err(crate::commands::CmdError {
            code: "license_required",
            detail: Some(EARLY_FEATURE.to_owned()),
        });
    }
    Ok(())
}

impl ShellSettings {
    /// What `shell_settings_put` stores: the person's switches, with the
    /// notice flag kept from `stored`.
    pub fn for_put(self, stored: &ShellSettings) -> Self {
        Self {
            tray_notice_shown: stored.tray_notice_shown,
            update_delay_days: nearest_update_delay(i64::from(self.update_delay_days)),
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
    /// Trust the folder in the agent's own store before an agent starts
    /// (fresh launches only).
    pub workspace_trust: bool,
    /// Directories put in front of the PATH of new terminals and agents. Valid
    /// entries only (see `agent_path::validate_entry`), each once.
    #[serde(deserialize_with = "lenient_items")]
    pub path_prepend: Vec<String>,
    /// Directories put after the PATH of new terminals and agents.
    #[serde(deserialize_with = "lenient_items")]
    pub path_append: Vec<String>,
    /// Where an agent opens when its profile does not say: a new tab, or a split
    /// of the current terminal.
    #[serde(deserialize_with = "lenient")]
    pub open_as: OpenAs,
}

/// Settings → Agents → Open agents as. A value this build does not know reads
/// as `Tab`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum OpenAs {
    /// A new tab.
    #[default]
    Tab,
    /// A pane to the right of the terminal.
    SplitRight,
    /// A pane below the terminal.
    SplitDown,
}

impl<'de> serde::Deserialize<'de> for OpenAs {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("splitRight") => OpenAs::SplitRight,
            Some("splitDown") => OpenAs::SplitDown,
            _ => OpenAs::Tab,
        })
    }
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
            workspace_trust: true,
            path_prepend: Vec::new(),
            path_append: Vec::new(),
            open_as: OpenAs::default(),
        }
    }
}

impl AgentsSettings {
    /// Holds `sleep_after_min` inside `SLEEP_AFTER_MIN_RANGE` and keeps only
    /// the valid PATH entries, each once.
    pub fn clamped(mut self) -> Self {
        self.path_prepend = crate::agent_path::clean_entries(&self.path_prepend);
        self.path_append = crate::agent_path::clean_entries(&self.path_append);
        self.sleep_after_min = self
            .sleep_after_min
            .clamp(*SLEEP_AFTER_MIN_RANGE.start(), *SLEEP_AFTER_MIN_RANGE.end());
        self
    }
}

/// Settings → Automations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct AutomationsSettings {
    /// Shows the Automations entry in the sidebar.
    pub show_button: bool,
    /// Deletes an automation without asking (the dialog's "Don't ask again").
    pub skip_delete_confirm: bool,
}

impl Default for AutomationsSettings {
    fn default() -> Self {
        AutomationsSettings {
            show_button: true,
            skip_delete_confirm: false,
        }
    }
}

/// Settings → Advanced. Every field is empty by default, which means "none".
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct NetworkSettings {
    /// `http://`, `https://` or `socks5://` URL; empty: no proxy. Used by new
    /// terminals and by the updater.
    pub proxy_url: String,
    /// Host patterns that skip the proxy, one per entry.
    pub no_proxy: Vec<String>,
    /// Package registry URL for new terminals (`npm_config_registry`); empty: none.
    pub node_mirror: String,
    /// What About and the diagnostics file call this machine; empty: the OS host name.
    pub machine_name: String,
    /// Force HTTP/1.1 on the updater's requests (for proxies that break HTTP/2).
    pub http1_only: bool,
}

impl NetworkSettings {
    /// Trims every field and cleans the bypass list. A proxy or mirror that does
    /// not validate is kept as typed (the put refuses it before it gets here).
    pub fn normalized(mut self) -> Self {
        self.proxy_url = self.proxy_url.trim().to_owned();
        self.node_mirror = self.node_mirror.trim().to_owned();
        self.no_proxy = crate::network::clean_no_proxy(&self.no_proxy);
        self.machine_name = crate::network::clean_machine_name(&self.machine_name);
        self
    }
}

/// Settings → Screenshots.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct CaptureSettings {
    /// The global capture shortcut is on.
    pub enabled: bool,
    /// The shortcut as an accelerator, such as `CmdOrCtrl+Alt+Shift+S`.
    pub shortcut: String,
    /// A pasted image opens the annotate dialog before it is sent.
    pub annotate_paste: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        CaptureSettings {
            enabled: true,
            shortcut: "CmdOrCtrl+Alt+Shift+S".to_owned(),
            annotate_paste: false,
        }
    }
}

/// How the dictation key records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SpeechMode {
    /// Press to start, press again to stop.
    #[default]
    Toggle,
    /// Record while the key is held.
    Hold,
}

/// An unknown value is the default, as for `LinksTarget`.
impl<'de> serde::Deserialize<'de> for SpeechMode {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("hold") => SpeechMode::Hold,
            _ => SpeechMode::Toggle,
        })
    }
}

/// The transcription model used when none is stored.
pub const DEFAULT_SPEECH_MODEL: &str = "gpt-4o-mini-transcribe";

/// Settings → Voice.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct SpeechSettings {
    pub mode: SpeechMode,
    /// The input device name; `None` is the system default.
    pub device: Option<String>,
    /// ISO-639-1 code; `None` lets the model detect it.
    pub language: Option<String>,
    /// The OpenAI transcription model id.
    pub model: String,
}

impl Default for SpeechSettings {
    fn default() -> Self {
        SpeechSettings {
            mode: SpeechMode::Toggle,
            device: None,
            language: None,
            model: DEFAULT_SPEECH_MODEL.to_owned(),
        }
    }
}

/// Where a link clicked in a terminal opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LinksTarget {
    /// A browser tab of the worktree.
    Pane,
    /// The system's default browser.
    #[default]
    System,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for LinksTarget {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("pane") => LinksTarget::Pane,
            _ => LinksTarget::System,
        })
    }
}

/// Settings → Browser.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserSettings {
    /// Where a terminal link opens; Shift while clicking picks the other place.
    pub open_links_in: LinksTarget,
    /// The search address, with `%s` for the words. Empty: text is read as an address.
    pub search_template: String,
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
/// every row shows, except worktrees made outside xDev, which wait in the
/// visibility dialog until they are shown.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
    /// Repo ids the sidebar is limited to; empty lists every project.
    pub project_filter: Vec<String>,
    /// Worktrees made outside xDev stay out of the sidebar until they are
    /// shown one by one.
    pub external_default_hidden: bool,
    /// Paths of worktrees the user hid from the sidebar.
    pub hidden_worktrees: Vec<String>,
    /// Paths of worktrees made outside xDev the user chose to show.
    pub shown_worktrees: Vec<String>,
}

impl Default for SidebarPrefs {
    fn default() -> Self {
        SidebarPrefs {
            hide_default: false,
            hide_detached: false,
            hide_automation: false,
            hide_cli: false,
            group_by: SidebarGroupBy::default(),
            sort: SidebarSort::default(),
            compact_cards: false,
            card: CardProps::default(),
            project_order: ProjectOrder::default(),
            pinned_in_groups: false,
            project_filter: Vec::new(),
            external_default_hidden: true,
            hidden_worktrees: Vec::new(),
            shown_worktrees: Vec::new(),
        }
    }
}

/// Most ids or paths a sidebar list keeps, and the longest one.
const SIDEBAR_LIST_MAX: usize = 2000;
const SIDEBAR_ENTRY_MAX: usize = 4096;

impl SidebarPrefs {
    /// The lists trimmed, de-duplicated in order, blank and over-long entries
    /// dropped, cut to `SIDEBAR_LIST_MAX`. A path in both visibility lists
    /// stays hidden.
    pub fn clamped(mut self) -> Self {
        self.project_filter = clean_list(self.project_filter);
        self.hidden_worktrees = clean_list(self.hidden_worktrees);
        self.shown_worktrees = clean_list(self.shown_worktrees);
        let hidden = &self.hidden_worktrees;
        self.shown_worktrees.retain(|p| !hidden.contains(p));
        self
    }
}

fn clean_list(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let item = item.trim().to_string();
        if item.is_empty() || item.len() > SIDEBAR_ENTRY_MAX || out.contains(&item) {
            continue;
        }
        out.push(item);
        if out.len() == SIDEBAR_LIST_MAX {
            break;
        }
    }
    out
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
    /// Accent or neutral token the tinted sidebar is washed with, one of
    /// `SIDEBAR_TINTS`; empty keeps the `side-tint` token. An unknown name is
    /// stored empty.
    #[serde(deserialize_with = "lenient")]
    pub sidebar_tint: String,
    /// How strong that wash is, 0.04..=0.30.
    #[serde(deserialize_with = "lenient_tint_opacity")]
    pub sidebar_tint_opacity: f32,
    /// Turns off transitions, animations and backdrop blur in the window.
    #[serde(deserialize_with = "lenient_bool_false")]
    pub reduce_effects: bool,
    /// Activity bar apps that are hidden, by id. Unknown ids and repeats are
    /// dropped when stored, and at least one app stays visible.
    #[serde(deserialize_with = "lenient_items")]
    pub hidden_apps: Vec<String>,
    /// The order of the activity bar apps, by id. Empty is the default order;
    /// a stored order holds every app once (see `clean_app_order`).
    #[serde(deserialize_with = "lenient_items")]
    pub app_order: Vec<String>,
    /// Which of xDev's own footer items show.
    #[serde(deserialize_with = "lenient")]
    pub status_bar: StatusBarItems,
    /// Native window frame, or xDev's own title bar. A file from before it loads `Native`.
    #[serde(deserialize_with = "lenient")]
    pub titlebar: TitlebarMode,
    /// The app name shows in the custom title bar.
    #[serde(deserialize_with = "lenient_show_titlebar_name")]
    pub show_titlebar_name: bool,
    /// Settings → Appearance → App icon: one of `APP_ICONS`. An unknown id,
    /// or a value that is no string, reads as `APP_ICON_DEFAULT`.
    #[serde(deserialize_with = "lenient_app_icon")]
    pub app_icon: String,
    /// Settings → Appearance → Theme colours: the id of the saved app theme; empty is Default.
    /// Only a valid file stem is kept (`[a-z0-9-]{1,33}`).
    #[serde(deserialize_with = "lenient")]
    pub app_theme: String,
    /// The first-terminal coachmark tour was finished or skipped.
    #[serde(deserialize_with = "lenient_bool_false")]
    pub tour_seen: bool,
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
            sidebar_tint: String::new(),
            sidebar_tint_opacity: SIDEBAR_TINT_OPACITY_DEFAULT,
            reduce_effects: false,
            hidden_apps: Vec::new(),
            app_order: Vec::new(),
            status_bar: StatusBarItems::default(),
            titlebar: TitlebarMode::Native,
            show_titlebar_name: true,
            app_icon: APP_ICON_DEFAULT.to_string(),
            app_theme: String::new(),
            tour_seen: false,
        }
    }
}

/// The app icon ids `UiSettings::app_icon` may hold, in the picker's order.
pub const APP_ICONS: [&str; 6] = ["default", "midnight", "light", "sunset", "forest", "mono"];

/// The icon the app ships with.
pub const APP_ICON_DEFAULT: &str = "default";

/// `id` when it is one of `APP_ICONS`, else `APP_ICON_DEFAULT`.
pub fn known_app_icon(id: &str) -> &'static str {
    APP_ICONS
        .iter()
        .find(|known| **known == id)
        .copied()
        .unwrap_or(APP_ICON_DEFAULT)
}

fn lenient_app_icon<'de, D: serde::Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    let raw: String = lenient_or(de, APP_ICON_DEFAULT.to_string())?;
    Ok(known_app_icon(&raw).to_string())
}

/// Token names `UiSettings::sidebar_tint` may hold.
pub const SIDEBAR_TINTS: [&str; 8] = [
    "accent", "signal", "violet", "ok", "warn", "orange", "danger", "text-2",
];

pub const SIDEBAR_TINT_OPACITY_DEFAULT: f32 = 0.10;

/// The activity bar apps, as in the window's `shell/apps.ts`.
pub const APP_IDS: [&str; 8] = [
    "docs", "changes", "tasks", "squads", "agents", "kit", "accounts", "terminal",
];

fn lenient_tint_opacity<'de, D: serde::Deserializer<'de>>(de: D) -> Result<f32, D::Error> {
    lenient_or(de, SIDEBAR_TINT_OPACITY_DEFAULT)
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
    pub keep_awake: bool,
}

impl Default for StatusBarItems {
    fn default() -> Self {
        StatusBarItems {
            branch: true,
            token_usage: true,
            agents: true,
            version: true,
            ports: true,
            keep_awake: true,
        }
    }
}

/// Settings → Appearance → Title bar. A value this build does not know reads
/// as `Native`, so it does not reset the zoom beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TitlebarMode {
    /// The operating system's window frame.
    #[default]
    Native,
    /// No system frame; the window draws its own title bar.
    Custom,
}

impl<'de> serde::Deserialize<'de> for TitlebarMode {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("custom") => TitlebarMode::Custom,
            _ => TitlebarMode::Native,
        })
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
    pub const SIDEBAR_TINT_OPACITY: RangeInclusive<f32> = 0.04..=0.30;

    /// As stored: the zoom inside its range; 1.0 when it is no number.
    pub fn clamped(mut self) -> Self {
        self.zoom = if self.zoom.is_finite() {
            self.zoom.clamp(*Self::ZOOM.start(), *Self::ZOOM.end())
        } else {
            1.0
        };
        self.ui_font = clean_ui_font(&self.ui_font);
        if !SIDEBAR_TINTS.contains(&self.sidebar_tint.as_str()) {
            self.sidebar_tint.clear();
        }
        self.sidebar_tint_opacity = if self.sidebar_tint_opacity.is_finite() {
            self.sidebar_tint_opacity.clamp(
                *Self::SIDEBAR_TINT_OPACITY.start(),
                *Self::SIDEBAR_TINT_OPACITY.end(),
            )
        } else {
            SIDEBAR_TINT_OPACITY_DEFAULT
        };
        self.hidden_apps = clean_hidden_apps(&self.hidden_apps);
        self.app_order = clean_app_order(&self.app_order);
        self.app_icon = known_app_icon(&self.app_icon).to_string();
        if !crate::terminal_themes::valid_stem(&self.app_theme) {
            self.app_theme.clear();
        }
        self
    }
}

/// Known app ids only, each once, in `APP_IDS` order; all of them hidden reads as none hidden.
fn clean_hidden_apps(raw: &[String]) -> Vec<String> {
    let kept: Vec<String> = APP_IDS
        .iter()
        .filter(|id| raw.iter().any(|r| r == *id))
        .map(|id| (*id).to_string())
        .collect();
    if kept.len() == APP_IDS.len() {
        Vec::new()
    } else {
        kept
    }
}

/// The listed known app ids once each, then the apps it left out in `APP_IDS`
/// order; the default order reads as none.
fn clean_app_order(raw: &[String]) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    for id in raw {
        if APP_IDS.contains(&id.as_str()) && !order.contains(id) {
            order.push(id.clone());
        }
    }
    for id in APP_IDS {
        if !order.iter().any(|o| o == id) {
            order.push((*id).to_string());
        }
    }
    if order.iter().map(String::as_str).eq(APP_IDS) {
        Vec::new()
    } else {
        order
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
    /// The service keeps the last 512 KB of each terminal's output on this
    /// device, so a terminal can show it after a restart; read at start.
    #[serde(deserialize_with = "lenient_save_scrollback")]
    pub save_scrollback: bool,
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
    /// Linux only (ignored elsewhere): a middle click pastes the terminal's selection.
    #[serde(deserialize_with = "lenient_bool_false")]
    pub middle_click_paste: bool,
    /// What a plain click on a terminal link does.
    #[serde(deserialize_with = "lenient")]
    pub link_click: TerminalLinkClick,
    /// What a middle click on a URL does; a value this build does not know reads as `Open`.
    #[serde(deserialize_with = "lenient_middle")]
    pub url_middle_click: TerminalLinkClick,
    /// macOS only: whether the Option key sends Alt/Esc sequences or composes characters.
    #[serde(deserialize_with = "lenient")]
    pub mac_option_as_alt: MacOptionAsAlt,
    /// The scheme used while the app is in light mode and `theme_follow_app` is on; same rule as
    /// `theme`.
    #[serde(deserialize_with = "lenient_theme_light")]
    pub theme_light: String,
    /// Off: `theme` in both modes. On: `theme_light` while the app is light.
    #[serde(deserialize_with = "lenient_bool_false")]
    pub theme_follow_app: bool,
    /// Draw the panes that do not have focus dimmer.
    #[serde(deserialize_with = "lenient_bool_false")]
    pub dim_inactive_panes: bool,
    /// The line between two panes, 1..=4 px.
    #[serde(deserialize_with = "lenient_divider")]
    pub pane_divider_px: u8,
    /// The weight of bold text.
    #[serde(deserialize_with = "lenient")]
    pub font_weight_bold: FontWeightBold,
    /// Typing scrolls the terminal to the bottom.
    #[serde(deserialize_with = "lenient_scroll_on_input")]
    pub scroll_on_input: bool,
    /// Space around the text, 0..=24 px.
    #[serde(deserialize_with = "lenient_padding")]
    pub padding_px: u8,
    /// 0.5..=1.0; 1 is opaque.
    #[serde(deserialize_with = "lenient_bg_opacity")]
    pub background_opacity: f32,
    /// bash, zsh, fish and PowerShell started by xDev report their prompts, exit codes and folder
    /// (OSC 133 and 7) through a script xDev loads; the owner's rc files are never changed.
    #[serde(deserialize_with = "lenient_shell_integration")]
    pub shell_integration: bool,
}

/// The theme id used in light mode when none is set.
pub const THEME_LIGHT_DEFAULT: &str = "one-light";

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
            save_scrollback: true,
            theme: THEME_APP.into(),
            gpu: TerminalGpu::Auto,
            bell: TerminalBell::None,
            word_separators: DEFAULT_WORD_SEPARATORS.into(),
            scroll_sensitivity: 1.15,
            fast_scroll_sensitivity: 5.0,
            minimum_contrast: 1.0,
            focus_follows_mouse: false,
            middle_click_paste: false,
            link_click: TerminalLinkClick::Actions,
            url_middle_click: TerminalLinkClick::Open,
            mac_option_as_alt: MacOptionAsAlt::Auto,
            theme_light: THEME_LIGHT_DEFAULT.into(),
            theme_follow_app: false,
            dim_inactive_panes: false,
            pane_divider_px: 1,
            font_weight_bold: FontWeightBold::Bold,
            scroll_on_input: true,
            padding_px: 8,
            background_opacity: 1.0,
            shell_integration: true,
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
    pub const DIVIDER_PX: RangeInclusive<u8> = 1..=4;
    pub const PADDING_PX: RangeInclusive<u8> = 0..=24;
    pub const BG_OPACITY: RangeInclusive<f32> = 0.5..=1.0;

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
        if !valid_theme_id(&self.theme_light) {
            self.theme_light = THEME_LIGHT_DEFAULT.into();
        }
        self.pane_divider_px = self
            .pane_divider_px
            .clamp(*Self::DIVIDER_PX.start(), *Self::DIVIDER_PX.end());
        self.padding_px = self
            .padding_px
            .clamp(*Self::PADDING_PX.start(), *Self::PADDING_PX.end());
        self.background_opacity = clamp_or(
            self.background_opacity,
            Self::BG_OPACITY,
            default.background_opacity,
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

/// Settings → Terminal → Bold weight.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum FontWeightBold {
    #[default]
    #[serde(rename = "bold")]
    #[cfg_attr(test, ts(rename = "bold"))]
    Bold,
    #[serde(rename = "600")]
    #[cfg_attr(test, ts(rename = "600"))]
    W600,
    #[serde(rename = "700")]
    #[cfg_attr(test, ts(rename = "700"))]
    W700,
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

/// What a click on a terminal link does. A value this build does not know reads as the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TerminalLinkClick {
    #[default]
    Actions,
    Open,
    None,
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
    Automations,
    Network,
    /// `terminalSets` and `startupPresets`.
    TerminalSets,
    Link,
    /// `cloud`.
    Cloud,
    Capture,
    Browser,
    Speech,
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
    // Which sound plays: one of the built-in ones, or the own file.
    pub sound_name: SoundName,
    // 0–100.
    pub volume: u8,
    // The header bell's count and list.
    pub bell: bool,
    // The taskbar or dock badge.
    pub badge: bool,
}

/// The status sound. All but `File` are made in the webview, with no files.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SoundName {
    #[default]
    TwoTone,
    Chime,
    Ding,
    Blip,
    Pop,
    Knock,
    /// The person's own file (`sound_file`).
    File,
}

/// The status section. A file from before `soundName` existed reads as the
/// own file when one is set, else as the two-tone beep; a value that does
/// not parse reads as the section's defaults.
fn lenient_status<'de, D: serde::Deserializer<'de>>(de: D) -> Result<StatusSettings, D::Error> {
    let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
    let named = value.get("soundName").is_some();
    let mut status: StatusSettings = serde_json::from_value(value).unwrap_or_default();
    if !named && status.sound_file.is_some() {
        status.sound_name = SoundName::File;
    }
    Ok(status)
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
            sound_name: SoundName::TwoTone,
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
    /// Asks an agent to review one changed hunk of the diff review screen.
    #[serde(deserialize_with = "lenient")]
    pub review_hunk: Recipe,
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
            review_hunk: self.review_hunk.normalized(),
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

/// How Source Control lists the changed files: one flat list, or folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SourceControlViewMode {
    #[default]
    List,
    Tree,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for SourceControlViewMode {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("tree") => SourceControlViewMode::Tree,
            _ => SourceControlViewMode::List,
        })
    }
}

/// Where the Issues panel opens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum IssuesPreset {
    #[default]
    All,
    Issues,
    MyIssues,
    Prs,
    MyPrs,
    Review,
}

/// An unknown value is the default, as for `TabOrder`.
impl<'de> serde::Deserialize<'de> for IssuesPreset {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("issues") => IssuesPreset::Issues,
            Some("my_issues") => IssuesPreset::MyIssues,
            Some("prs") => IssuesPreset::Prs,
            Some("my_prs") => IssuesPreset::MyPrs,
            Some("review") => IssuesPreset::Review,
            _ => IssuesPreset::All,
        })
    }
}

fn lenient_true<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    lenient_or(de, true)
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
    /// Whether Source Control lists the changed files flat or by folder.
    pub source_control_view_mode: SourceControlViewMode,
    /// Logins (lowercase) treated as bots in a pull request's comments, on top
    /// of the ones GitHub marks as bots. A wrong type costs only this field.
    #[serde(deserialize_with = "lenient")]
    pub pr_bot_author_overrides: Vec<String>,
    /// How Pull and Sync combine local and remote commits.
    pub pull_policy: PullPolicy,
    /// Where the Issues panel opens.
    pub issues_default_view: IssuesPreset,
    /// Show the Issues tab in the side panel.
    #[serde(deserialize_with = "lenient_true")]
    pub show_issues_tab: bool,
    /// The prompts behind the agent actions. A part that does not parse
    /// falls back to the defaults on its own.
    #[serde(deserialize_with = "lenient")]
    pub recipes: GitRecipes,
    /// Where new worktrees go for a repo whose own folder is the default; an
    /// absolute path, or empty for `<repo parent>/wt`.
    pub worktree_dir: String,
    /// The worktree folders last used, newest first, at most
    /// `WORKTREE_DIR_HISTORY_MAX`.
    #[serde(deserialize_with = "lenient")]
    pub worktree_dir_history: Vec<String>,
    /// The tip that the local base is behind its upstream was turned off.
    pub local_base_refresh_tip_dismissed: bool,
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
            source_control_view_mode: SourceControlViewMode::default(),
            pr_bot_author_overrides: Vec::new(),
            pull_policy: PullPolicy::default(),
            issues_default_view: IssuesPreset::default(),
            show_issues_tab: true,
            recipes: GitRecipes::default(),
            worktree_dir: String::new(),
            worktree_dir_history: Vec::new(),
            local_base_refresh_tip_dismissed: false,
        }
    }
}

impl GitSettings {
    /// As stored: the custom prefix normalized the way names use it.
    pub fn normalized(mut self) -> GitSettings {
        self.branch_prefix_custom = xdev_workspace::normalize_prefix(&self.branch_prefix_custom);
        self.recipes = self.recipes.normalized();
        self.pr_bot_author_overrides = normalize_bot_overrides(self.pr_bot_author_overrides);
        self.worktree_dir = absolute_dir(&self.worktree_dir).unwrap_or_default();
        let history = std::mem::take(&mut self.worktree_dir_history);
        self.worktree_dir_history = history
            .iter()
            .rev()
            .chain(std::iter::once(&self.worktree_dir))
            .fold(Vec::new(), |h, dir| push_dir_history(h, dir));
        self
    }

    /// Whether the tip that the local base is `behind` commits behind its
    /// upstream is shown: only when refreshing before create is off and the
    /// tip was not turned off.
    pub fn shows_base_tip(&self, behind: u32) -> bool {
        behind > 0 && !self.refresh_local_base_on_create && !self.local_base_refresh_tip_dismissed
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
            worktree_dir: absolute_dir(&self.worktree_dir).map(std::path::PathBuf::from),
            ..xdev_workspace::CreateOptions::default()
        }
    }
}

/// Most folders `GitSettings::worktree_dir_history` keeps.
pub const WORKTREE_DIR_HISTORY_MAX: usize = 5;

/// `dir` trimmed, when it is an absolute path.
fn absolute_dir(dir: &str) -> Option<String> {
    let dir = dir.trim();
    std::path::Path::new(dir)
        .is_absolute()
        .then(|| dir.to_owned())
}

/// `history` with `dir` first: trimmed, once, at most
/// `WORKTREE_DIR_HISTORY_MAX` folders. A blank or relative `dir` leaves it
/// as it is.
pub fn push_dir_history(mut history: Vec<String>, dir: &str) -> Vec<String> {
    if let Some(dir) = absolute_dir(dir) {
        history.retain(|d| d.trim() != dir);
        history.insert(0, dir);
    }
    history.truncate(WORKTREE_DIR_HISTORY_MAX);
    history
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

fn lenient_save_scrollback<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    lenient_or(de, true)
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

fn lenient_middle<'de, D: serde::Deserializer<'de>>(de: D) -> Result<TerminalLinkClick, D::Error> {
    lenient_or(de, TerminalLinkClick::Open)
}

fn lenient_theme<'de, D: serde::Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    lenient_or(de, THEME_APP.to_owned())
}

fn lenient_theme_light<'de, D: serde::Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    lenient_or(de, THEME_LIGHT_DEFAULT.to_owned())
}

fn lenient_divider<'de, D: serde::Deserializer<'de>>(de: D) -> Result<u8, D::Error> {
    lenient_or(de, TerminalSettings::default().pane_divider_px)
}

fn lenient_padding<'de, D: serde::Deserializer<'de>>(de: D) -> Result<u8, D::Error> {
    lenient_or(de, TerminalSettings::default().padding_px)
}

fn lenient_bg_opacity<'de, D: serde::Deserializer<'de>>(de: D) -> Result<f32, D::Error> {
    lenient_or(de, TerminalSettings::default().background_opacity)
}

fn lenient_scroll_on_input<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    lenient_or(de, true)
}

fn lenient_shell_integration<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    lenient_or(de, true)
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

fn lenient_show_titlebar_name<'de, D: serde::Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    lenient_or(de, true)
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
                applog::warn(
                    "settings",
                    &format!("dropped a list entry that does not parse: {e}"),
                );
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
        applog::warn(
            "settings",
            &format!(
                "{} is version {version}, newer than this build's {VERSION}; keys this build does not know are dropped on the next save",
                path.display()
            ),
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

    fn key() -> String {
        xdev_license::b64::encode(&[7u8; 32])
    }

    #[test]
    fn cloud_defaults_to_the_official_service() {
        let c = CloudSettings::default().checked(false).unwrap();
        assert_eq!(c, CloudSettings::default());
        let s: Settings = serde_json::from_str(r#"{"cloud":{"serverUrl":5}}"#).unwrap();
        assert_eq!(s.cloud, CloudSettings::default());
    }

    #[test]
    fn cloud_custom_server_needs_a_root() {
        let c = CloudSettings {
            server_url: Some(" https://id.example.com/ ".into()),
            pinned_roots: vec![],
        };
        assert_eq!(c.checked(false), Err("cloud_need_root"));
        let ok = CloudSettings {
            pinned_roots: vec![key(), format!(" {} ", key())],
            ..c
        }
        .checked(false)
        .unwrap();
        assert_eq!(ok.server_url.as_deref(), Some("https://id.example.com"));
        assert_eq!(ok.pinned_roots, vec![key()]);
    }

    #[test]
    fn cloud_rejects_bad_urls_and_roots() {
        let bad = |url: &str, roots: Vec<String>| {
            CloudSettings {
                server_url: Some(url.into()),
                pinned_roots: roots,
            }
            .checked(false)
        };
        assert_eq!(
            bad("http://id.example.com", vec![key()]),
            Err("cloud_bad_url")
        );
        assert_eq!(
            bad("http://localhost:8787", vec![key()]),
            Err("cloud_bad_url")
        );
        assert_eq!(bad("ftp://x", vec![key()]), Err("cloud_bad_url"));
        assert_eq!(
            bad("https://x.example/a", vec![key()]),
            Err("cloud_bad_url")
        );
        assert_eq!(
            bad("https://x.example", vec!["short".into()]),
            Err("cloud_bad_root")
        );
        let local = CloudSettings {
            server_url: Some("http://localhost:8787".into()),
            pinned_roots: vec![key()],
        };
        assert!(local.checked(true).is_ok());
    }

    #[test]
    fn cloud_ignores_roots_for_the_official_server() {
        let c = CloudSettings {
            server_url: Some(xdev_license::cloud::DEFAULT_SERVER.into()),
            pinned_roots: vec![key()],
        }
        .checked(false)
        .unwrap();
        assert_eq!(c, CloudSettings::default());
    }

    #[test]
    fn link_defaults_off_and_reads_lenient() {
        let d = LinkSettings::default();
        assert!(!d.enabled);
        assert_eq!(d.bind, xdev_link::LinkBind::Localhost);
        assert_eq!(d.port, 47821);
        assert!(!d.confirm_each);
        assert_eq!(Settings::default().link, d);
        let read = |json: &str| -> Settings { serde_json::from_str(json).unwrap() };
        assert_eq!(read(r#"{"link":{"bind":"nope"}}"#).link, d);
        let on = read(r#"{"link":{"enabled":true,"bind":"lan","confirmEach":true}}"#).link;
        assert!(on.enabled && on.confirm_each);
        assert_eq!(on.bind, xdev_link::LinkBind::Lan);
    }

    #[test]
    fn sound_name_defaults_from_sound_file() {
        let read = |json: &str| -> Settings { serde_json::from_str(json).unwrap() };
        let old_plain = read(r#"{"status":{"volume":10}}"#);
        assert_eq!(old_plain.status.sound_name, SoundName::TwoTone);
        let old_file = read(r#"{"status":{"soundFile":"C:/x/custom.wav"}}"#);
        assert_eq!(old_file.status.sound_name, SoundName::File);
        let chosen = read(r#"{"status":{"soundFile":"C:/x/custom.wav","soundName":"chime"}}"#);
        assert_eq!(chosen.status.sound_name, SoundName::Chime);
        let bad = read(r#"{"status":{"soundName":"nope","volume":10}}"#);
        assert_eq!(bad.status, StatusSettings::default());
    }

    #[test]
    fn save_scrollback_defaults_true_and_reads_lenient() {
        assert!(TerminalSettings::default().save_scrollback);
        let read = |json: &str| serde_json::from_str::<TerminalSettings>(json).unwrap();
        assert!(read("{}").save_scrollback);
        assert!(!read(r#"{"saveScrollback": false}"#).save_scrollback);
        assert!(read(r#"{"saveScrollback": "no"}"#).save_scrollback);
        assert!(read(r#"{"saveScrollback": null}"#).save_scrollback);
    }

    #[test]
    fn shell_integration_defaults_true_and_reads_lenient() {
        assert!(TerminalSettings::default().shell_integration);
        let read = |json: &str| serde_json::from_str::<TerminalSettings>(json).unwrap();
        assert!(read("{}").shell_integration);
        assert!(!read(r#"{"shellIntegration": false}"#).shell_integration);
        assert!(read(r#"{"shellIntegration": "off"}"#).shell_integration);
    }

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
                source_control_view_mode: SourceControlViewMode::Tree,
                pr_bot_author_overrides: vec!["renovate".into()],
                pull_policy: PullPolicy::GitConfig,
                issues_default_view: IssuesPreset::MyPrs,
                show_issues_tab: false,
                recipes: GitRecipes::default(),
                worktree_dir: "/trees".into(),
                worktree_dir_history: vec!["/trees".into(), "/old".into()],
                local_base_refresh_tip_dismissed: true,
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
    fn an_old_git_section_has_no_worktree_dir_and_shows_the_base_tip() {
        let old: GitSettings = serde_json::from_str(r#"{ "branchPrefix": "none" }"#).unwrap();
        assert_eq!(old.worktree_dir, "");
        assert!(old.worktree_dir_history.is_empty());
        assert!(!old.local_base_refresh_tip_dismissed);
        assert_eq!(old.create_options().worktree_dir, None);
        // A wrong history type costs only the history.
        let bad: GitSettings =
            serde_json::from_str(r#"{ "worktreeDir": "/w", "worktreeDirHistory": 3 }"#).unwrap();
        assert_eq!(bad.worktree_dir, "/w");
        assert!(bad.worktree_dir_history.is_empty());
    }

    /// `p` as an absolute path on this OS (`/x` is not absolute on Windows).
    fn abs(p: &str) -> String {
        if cfg!(windows) {
            format!("C:{p}")
        } else {
            p.to_owned()
        }
    }

    #[test]
    fn worktree_dir_history_is_newest_first_deduped_and_capped() {
        let h = push_dir_history(vec![abs("/a"), abs("/b")], &format!(" {} ", abs("/b")));
        assert_eq!(h, [abs("/b"), abs("/a")]);
        assert_eq!(push_dir_history(h.clone(), "rel/dir"), h);
        assert_eq!(push_dir_history(h.clone(), "  "), h);
        let full = (0..WORKTREE_DIR_HISTORY_MAX + 3).fold(Vec::new(), |h, n| {
            push_dir_history(h, &abs(&format!("/d{n}")))
        });
        assert_eq!(full.len(), WORKTREE_DIR_HISTORY_MAX);
        assert_eq!(full[0], abs(&format!("/d{}", WORKTREE_DIR_HISTORY_MAX + 2)));
    }

    #[test]
    fn normalized_keeps_an_absolute_worktree_dir_and_records_it() {
        let git = GitSettings {
            worktree_dir: format!(" {} ", abs("/trees")),
            worktree_dir_history: vec![abs("/old"), "rel".into(), abs("/trees")],
            ..GitSettings::default()
        }
        .normalized();
        assert_eq!(git.worktree_dir, abs("/trees"));
        assert_eq!(git.worktree_dir_history, [abs("/trees"), abs("/old")]);
        assert_eq!(
            git.create_options().worktree_dir,
            Some(std::path::PathBuf::from(abs("/trees")))
        );
        let relative = GitSettings {
            worktree_dir: "trees".into(),
            worktree_dir_history: (0..9).map(|n| abs(&format!("/h{n}"))).collect(),
            ..GitSettings::default()
        }
        .normalized();
        assert_eq!(relative.worktree_dir, "");
        let first_five: Vec<String> = (0..5).map(|n| abs(&format!("/h{n}"))).collect();
        assert_eq!(relative.worktree_dir_history, first_five);
        assert_eq!(relative.create_options().worktree_dir, None);
    }

    #[test]
    fn base_tip_shows_only_when_behind_and_not_turned_off() {
        let git = GitSettings::default();
        assert!(git.shows_base_tip(3));
        assert!(!git.shows_base_tip(0));
        let refreshing = GitSettings {
            refresh_local_base_on_create: true,
            ..GitSettings::default()
        };
        assert!(!refreshing.shows_base_tip(3));
        let dismissed = GitSettings {
            local_base_refresh_tip_dismissed: true,
            ..GitSettings::default()
        };
        assert!(!dismissed.shows_base_tip(3));
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
                sound_name: SoundName::File,
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
        // A file written before the switch existed reads it as off.
        assert!(!t.middle_click_paste);
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
            save_scrollback: false,
            theme: "tokyo-night".into(),
            gpu: TerminalGpu::Off,
            bell: TerminalBell::Visual,
            word_separators: " /".into(),
            scroll_sensitivity: 2.5,
            fast_scroll_sensitivity: 8.0,
            minimum_contrast: 4.5,
            focus_follows_mouse: true,
            middle_click_paste: true,
            link_click: TerminalLinkClick::Open,
            url_middle_click: TerminalLinkClick::None,
            mac_option_as_alt: MacOptionAsAlt::Left,
            theme_light: "rose-pine-dawn".into(),
            theme_follow_app: true,
            dim_inactive_panes: true,
            pane_divider_px: 3,
            font_weight_bold: FontWeightBold::W600,
            scroll_on_input: false,
            padding_px: 12,
            background_opacity: 0.8,
            shell_integration: false,
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
    fn titlebar_defaults_for_an_old_file() {
        let old: UiSettings = serde_json::from_str(r#"{"zoom":1.5}"#).unwrap();
        assert_eq!(old.titlebar, TitlebarMode::Native);
        assert!(old.show_titlebar_name);
        let odd: UiSettings =
            serde_json::from_str(r#"{"zoom":1.5,"titlebar":"wide","showTitlebarName":"no"}"#)
                .unwrap();
        assert_eq!(odd.zoom, 1.5);
        assert_eq!(odd.titlebar, TitlebarMode::Native);
        assert!(odd.show_titlebar_name);
    }

    #[test]
    fn titlebar_round_trips() {
        let ui = UiSettings {
            titlebar: TitlebarMode::Custom,
            show_titlebar_name: false,
            ..UiSettings::default()
        };
        let json = serde_json::to_string(&ui).unwrap();
        assert!(json.contains(r#""titlebar":"custom""#));
        assert!(json.contains(r#""showTitlebarName":false"#));
        assert_eq!(serde_json::from_str::<UiSettings>(&json).unwrap(), ui);
        assert_eq!(ui.clone().clamped(), ui);
    }

    #[test]
    fn more_appearance_defaults_and_an_old_file() {
        let ui = UiSettings::default();
        assert_eq!(ui.sidebar_tint, "");
        assert_eq!(ui.sidebar_tint_opacity, 0.10);
        assert!(!ui.reduce_effects);
        assert!(ui.hidden_apps.is_empty());
        assert!(ui.status_bar.keep_awake);

        let old: UiSettings =
            serde_json::from_str(r#"{"zoom":1.5,"statusBar":{"branch":false}}"#).unwrap();
        assert_eq!(old.zoom, 1.5);
        assert_eq!(old.sidebar_tint, "");
        assert_eq!(old.sidebar_tint_opacity, 0.10);
        assert!(!old.reduce_effects);
        assert!(old.hidden_apps.is_empty());
        assert!(!old.status_bar.branch && old.status_bar.keep_awake);

        let odd: UiSettings = serde_json::from_str(r#"{"zoom":1.5,"sidebarTint":4,"sidebarTintOpacity":"x","reduceEffects":"yes","hiddenApps":"docs"}"#).unwrap();
        assert_eq!(odd.zoom, 1.5);
        assert_eq!(odd.sidebar_tint, "");
        assert_eq!(odd.sidebar_tint_opacity, 0.10);
        assert!(!odd.reduce_effects);
        assert!(odd.hidden_apps.is_empty());
    }

    #[test]
    fn app_icon_defaults_for_an_old_file() {
        assert_eq!(UiSettings::default().app_icon, "default");
        let old: UiSettings = serde_json::from_str(r#"{"zoom":1.5}"#).unwrap();
        assert_eq!(old.app_icon, "default");
    }

    #[test]
    fn app_icon_falls_back_to_default_when_unknown() {
        let odd: UiSettings = serde_json::from_str(r#"{"zoom":1.5,"appIcon":"rainbow"}"#).unwrap();
        assert_eq!(odd.zoom, 1.5);
        assert_eq!(odd.app_icon, "default");
        let wrong: UiSettings = serde_json::from_str(r#"{"zoom":1.5,"appIcon":4}"#).unwrap();
        assert_eq!(wrong.zoom, 1.5);
        assert_eq!(wrong.app_icon, "default");
        let put = UiSettings {
            app_icon: "../icon".into(),
            ..UiSettings::default()
        };
        assert_eq!(put.clamped().app_icon, "default");
    }

    #[test]
    fn app_theme_is_lenient_and_keeps_only_a_stem() {
        assert_eq!(UiSettings::default().app_theme, "");
        let old: UiSettings = serde_json::from_str(r#"{"zoom":1.5}"#).unwrap();
        assert_eq!(old.app_theme, "");
        let wrong: UiSettings = serde_json::from_str(r#"{"zoom":1.5,"appTheme":4}"#).unwrap();
        assert_eq!((wrong.zoom, wrong.app_theme.as_str()), (1.5, ""));
        let ok = UiSettings {
            app_theme: "dusk-2".into(),
            ..UiSettings::default()
        };
        assert_eq!(ok.clamped().app_theme, "dusk-2");
        let bad = UiSettings {
            app_theme: "../x".into(),
            ..UiSettings::default()
        };
        assert_eq!(bad.clamped().app_theme, "");
    }

    #[test]
    fn app_icon_keeps_a_known_id_and_round_trips() {
        for id in APP_ICONS {
            let ui = UiSettings {
                app_icon: id.into(),
                ..UiSettings::default()
            };
            let json = serde_json::to_string(&ui).unwrap();
            assert!(json.contains(&format!(r#""appIcon":"{id}""#)));
            assert_eq!(serde_json::from_str::<UiSettings>(&json).unwrap(), ui);
            assert_eq!(ui.clone().clamped(), ui);
        }
    }

    #[test]
    fn sidebar_tint_is_a_known_token_and_its_opacity_is_clamped() {
        let tint = |name: &str, opacity: f32| {
            let ui = UiSettings {
                sidebar_tint: name.into(),
                sidebar_tint_opacity: opacity,
                ..UiSettings::default()
            }
            .clamped();
            (ui.sidebar_tint, ui.sidebar_tint_opacity)
        };
        assert_eq!(tint("violet", 0.2), ("violet".to_string(), 0.2));
        assert_eq!(tint("#ff0000", 0.2).0, "");
        assert_eq!(tint("", 0.2).0, "");
        assert_eq!(tint("ok", 0.0).1, 0.04);
        assert_eq!(tint("ok", 0.9).1, 0.30);
        assert_eq!(tint("ok", f32::NAN).1, 0.10);
        assert_eq!(tint("ok", f32::INFINITY).1, 0.10);
    }

    #[test]
    fn app_order_keeps_known_ids_once_and_fills_the_rest() {
        let order =
            |ids: &[&str]| clean_app_order(&ids.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(order(&[]).is_empty());
        assert!(order(&APP_IDS).is_empty());
        assert_eq!(
            order(&["terminal", "nope", "docs", "terminal"]),
            [
                "terminal", "docs", "changes", "tasks", "squads", "agents", "kit", "accounts"
            ]
        );
    }

    #[test]
    fn agent_path_entries_are_cleaned_when_stored() {
        let saved = AgentsSettings {
            path_prepend: vec![" /a ".into(), "".into(), "/a".into()],
            path_append: vec!["x y".into(), "/b".into()],
            ..AgentsSettings::default()
        }
        .clamped();
        assert_eq!(saved.path_prepend, ["/a"]);
        assert_eq!(saved.path_append, ["/b"]);
    }

    #[test]
    fn hidden_apps_keep_known_ids_once_and_never_hide_everything() {
        let hidden = |ids: &[&str]| {
            UiSettings {
                hidden_apps: ids.iter().map(|s| s.to_string()).collect(),
                ..UiSettings::default()
            }
            .clamped()
            .hidden_apps
        };
        assert_eq!(hidden(&["kit", "nope", "docs", "kit"]), ["docs", "kit"]);
        assert!(hidden(&["nope"]).is_empty());
        assert_eq!(hidden(&APP_IDS[1..]).len(), 7);
        assert!(hidden(&APP_IDS).is_empty());
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
    fn visibility_fields_default_when_an_old_file_lacks_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{ "sidebar": { "hideCli": true, "sort": "name" } }"#,
        )
        .unwrap();
        let sb = load(&path).sidebar;
        assert!(sb.hide_cli);
        assert!(sb.project_filter.is_empty());
        assert!(sb.external_default_hidden);
        assert!(sb.hidden_worktrees.is_empty() && sb.shown_worktrees.is_empty());
        let sb: SidebarPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(sb, SidebarPrefs::default());
    }

    #[test]
    fn visibility_fields_round_trip() {
        let want = SidebarPrefs {
            project_filter: vec!["r1".into()],
            external_default_hidden: false,
            hidden_worktrees: vec!["/a".into()],
            shown_worktrees: vec!["/b".into()],
            ..SidebarPrefs::default()
        };
        let text = serde_json::to_string(&want).unwrap();
        assert!(text.contains(r#""externalDefaultHidden":false"#));
        assert!(text.contains(r#""projectFilter":["r1"]"#));
        let back: SidebarPrefs = serde_json::from_str(&text).unwrap();
        assert_eq!(back, want);
    }

    #[test]
    fn sidebar_lists_are_trimmed_deduped_and_bounded() {
        let long = "x".repeat(SIDEBAR_ENTRY_MAX + 1);
        let many: Vec<String> = (0..SIDEBAR_LIST_MAX + 50)
            .map(|i| format!("/w{i}"))
            .collect();
        let sb = SidebarPrefs {
            project_filter: vec![
                " a ".into(),
                "a".into(),
                "".into(),
                "  ".into(),
                long,
                "b".into(),
            ],
            hidden_worktrees: many,
            shown_worktrees: vec!["/w1".into(), "/keep".into()],
            ..SidebarPrefs::default()
        }
        .clamped();
        assert_eq!(sb.project_filter, vec!["a", "b"]);
        assert_eq!(sb.hidden_worktrees.len(), SIDEBAR_LIST_MAX);
        // Hidden wins over shown.
        assert_eq!(sb.shown_worktrees, vec!["/keep"]);
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
    fn source_control_view_mode_defaults_to_list_and_round_trips() {
        let git: GitSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(git.source_control_view_mode, SourceControlViewMode::List);
        let git: GitSettings =
            serde_json::from_str(r#"{ "sourceControlViewMode": "tree" }"#).unwrap();
        assert_eq!(git.source_control_view_mode, SourceControlViewMode::Tree);
        let text = serde_json::to_string(&git).unwrap();
        assert!(text.contains(r#""sourceControlViewMode":"tree""#));
        let bad: GitSettings = serde_json::from_str(r#"{ "sourceControlViewMode": 4 }"#).unwrap();
        assert_eq!(bad.source_control_view_mode, SourceControlViewMode::List);
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
    fn git_settings_defaults_issues_view_all_and_tab_shown() {
        let git: GitSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(git.issues_default_view, IssuesPreset::All);
        assert!(git.show_issues_tab);
        let out = serde_json::to_string(&GitSettings::default()).unwrap();
        assert!(out.contains(r#""issuesDefaultView":"all""#), "{out}");
        assert!(out.contains(r#""showIssuesTab":true"#), "{out}");
    }

    #[test]
    fn git_settings_unknown_preset_falls_back() {
        for (text, want) in [
            ("issues", IssuesPreset::Issues),
            ("my_issues", IssuesPreset::MyIssues),
            ("prs", IssuesPreset::Prs),
            ("my_prs", IssuesPreset::MyPrs),
            ("review", IssuesPreset::Review),
        ] {
            let git: GitSettings =
                serde_json::from_str(&format!(r#"{{"issuesDefaultView":"{text}"}}"#)).unwrap();
            assert_eq!(git.issues_default_view, want);
        }
        let bad: GitSettings = serde_json::from_str(r#"{"issuesDefaultView":"x"}"#).unwrap();
        assert_eq!(bad.issues_default_view, IssuesPreset::All);
        let num: GitSettings =
            serde_json::from_str(r#"{"issuesDefaultView":3,"showIssuesTab":"no"}"#).unwrap();
        assert_eq!(num.issues_default_view, IssuesPreset::All);
        assert!(num.show_issues_tab);
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
    fn an_old_agents_section_reads_workspace_trust_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        for text in [
            "{}",
            r#"{ "agents": { "accountSwitch": "keep" } }"#,
            r#"{ "agents": { "workspaceTrust": "yes" } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert!(load(&path).agents.workspace_trust, "{text}");
        }
        fs::write(&path, r#"{ "agents": { "workspaceTrust": false } }"#).unwrap();
        assert!(!load(&path).agents.workspace_trust);
    }

    #[test]
    fn open_as_and_tour_seen_default_round_trip_and_stay_lenient() {
        assert_eq!(AgentsSettings::default().open_as, OpenAs::Tab);
        assert!(!UiSettings::default().tour_seen);
        for (value, json) in [
            (OpenAs::SplitRight, "splitRight"),
            (OpenAs::SplitDown, "splitDown"),
        ] {
            assert_eq!(serde_json::to_value(value).unwrap(), json);
            let back: AgentsSettings =
                serde_json::from_value(serde_json::json!({ "openAs": json })).unwrap();
            assert_eq!(back.open_as, value);
        }
        let odd: AgentsSettings =
            serde_json::from_value(serde_json::json!({ "openAs": "floating" })).unwrap();
        assert_eq!(odd.open_as, OpenAs::Tab);
        let ui: UiSettings =
            serde_json::from_value(serde_json::json!({ "tourSeen": true })).unwrap();
        assert!(ui.tour_seen);
        let bad: UiSettings =
            serde_json::from_value(serde_json::json!({ "tourSeen": "yes" })).unwrap();
        assert!(!bad.tour_seen);
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
                    "sessionSearch": false,
                    "workspaceTrust": true,
                    "pathPrepend": [],
                    "pathAppend": [],
                    "openAs": "tab"
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
    fn failover_settings_are_off_by_default_and_normalized() {
        let d = OrchestrationSettings::default();
        assert!(!d.failover_enabled);
        assert!(d.failover_backup_account);
        assert!(d.failover_backup_agents.is_empty());
        assert_eq!(d.failover_max, 2);
        assert!(!d.autopilot_restart);
        assert_eq!(d.stuck_minutes, 10);
        let n = OrchestrationSettings {
            failover_max: 99,
            stuck_minutes: 0,
            failover_backup_agents: [
                " codex", "", "codex", "claude", "a", "b", "c", "d", "e", "f", "g",
            ]
            .map(str::to_owned)
            .to_vec(),
            ..d.clone()
        }
        .normalized();
        assert_eq!(n.failover_max, 5);
        assert_eq!(n.stuck_minutes, 1);
        assert_eq!(
            n.failover_backup_agents,
            ["codex", "claude", "a", "b", "c", "d", "e", "f"]
        );
        let n = OrchestrationSettings {
            stuck_minutes: 500,
            ..d
        }
        .normalized();
        assert_eq!(n.stuck_minutes, 120);
        // Settings from before failover read as the defaults.
        let old: OrchestrationSettings =
            serde_json::from_str(r#"{ "nestedWorkerMaxDepth": 2, "workerAutoClose": false }"#)
                .unwrap();
        assert!(!old.failover_enabled);
        assert_eq!(old.failover_max, 2);
    }

    #[test]
    fn orchestration_depth_is_clamped_to_one_through_nine() {
        let depth = |n: u32| {
            OrchestrationSettings {
                nested_worker_max_depth: n,
                ..OrchestrationSettings::default()
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
    fn automations_settings_default_and_stay_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let want = AutomationsSettings::default();
        assert!(want.show_button);
        assert!(!want.skip_delete_confirm);
        for text in [
            "{}",
            r#"{ "automations": {} }"#,
            r#"{ "automations": 3 }"#,
            r#"{ "automations": { "showButton": "yes" } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).automations, want, "{text}");
        }
        // A broken section keeps the other sections.
        fs::write(
            &path,
            r#"{ "automations": [1], "agents": { "accountSwitch": "keep" } }"#,
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.automations, want);
        assert_eq!(loaded.agents.account_switch, SwitchRunning::Keep);
        // A half-written section keeps the field it has.
        fs::write(&path, r#"{ "automations": { "skipDeleteConfirm": true } }"#).unwrap();
        let loaded = load(&path).automations;
        assert!(loaded.show_button && loaded.skip_delete_confirm);
    }

    #[test]
    fn automations_settings_round_trip_in_camel_case() {
        let on = AutomationsSettings {
            show_button: false,
            skip_delete_confirm: true,
        };
        let text = serde_json::to_string(&on).unwrap();
        assert_eq!(text, r#"{"showButton":false,"skipDeleteConfirm":true}"#);
        assert_eq!(
            serde_json::from_str::<AutomationsSettings>(&text).unwrap(),
            on
        );
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
        assert!(!want.notch_status);
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
            update_delay_days: 3,
            notch_status: true,
        };
        let json = serde_json::to_value(&shell).unwrap();
        assert_eq!(json["updateDelayDays"], 3);
        assert_eq!(json["notchStatus"], true);
        assert_eq!(json["minimizeToTray"], true);
        assert_eq!(json["menuBarIcon"], false);
        assert_eq!(json["trayNoticeShown"], true);
        assert_eq!(json["updateChannel"], "rc");
        fs::write(&path, format!(r#"{{ "shell": {json} }}"#)).unwrap();
        assert_eq!(load(&path).shell, shell);
    }

    #[test]
    fn an_old_shell_section_loads_with_no_update_delay() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{ "shell": { "minimizeToTray": true, "menuBarIcon": false, "trayNoticeShown": true, "updateChannel": "rc" } }"#,
        )
        .unwrap();
        let shell = load(&path).shell;
        assert_eq!(shell.update_delay_days, 0);
        assert!(!shell.notch_status);
        assert!(shell.minimize_to_tray);
        assert_eq!(shell.update_channel, UpdateChannel::Rc);
    }

    #[test]
    fn the_update_delay_is_clamped_to_the_nearest_allowed_value() {
        for (days, want) in [
            (-5, 0),
            (0, 0),
            (1, 1),
            (2, 1),
            (3, 3),
            (4, 3),
            (5, 3),
            (6, 7),
            (7, 7),
            (30, 7),
            (i64::MAX, 7),
        ] {
            assert_eq!(nearest_update_delay(days), want, "{days}");
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        for (text, want) in [
            (r#"{ "shell": { "updateDelayDays": 7 } }"#, 7),
            (r#"{ "shell": { "updateDelayDays": 4 } }"#, 3),
            (r#"{ "shell": { "updateDelayDays": 900 } }"#, 7),
            (r#"{ "shell": { "updateDelayDays": -2 } }"#, 0),
            (r#"{ "shell": { "updateDelayDays": 2.4 } }"#, 1),
            (r#"{ "shell": { "updateDelayDays": "3" } }"#, 0),
            (r#"{ "shell": { "updateDelayDays": null } }"#, 0),
            (r#"{ "shell": { "updateDelayDays": 1e30 } }"#, 7),
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).shell.update_delay_days, want, "{text}");
        }
        let put = ShellSettings {
            update_delay_days: 200,
            ..ShellSettings::default()
        }
        .for_put(&ShellSettings::default());
        assert_eq!(put.update_delay_days, 7);
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

    #[test]
    fn terminal_link_click_defaults_and_reads_leniently() {
        let t: TerminalSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(t.link_click, TerminalLinkClick::Actions);
        assert_eq!(t.url_middle_click, TerminalLinkClick::Open);

        let t: TerminalSettings =
            serde_json::from_str(r#"{ "linkClick": "bogus", "urlMiddleClick": "bogus" }"#).unwrap();
        assert_eq!(t.link_click, TerminalLinkClick::Actions);
        assert_eq!(t.url_middle_click, TerminalLinkClick::Open);

        // A bad value costs only itself.
        let t: TerminalSettings =
            serde_json::from_str(r#"{ "linkClick": "none", "urlMiddleClick": 7, "fontSize": 15 }"#)
                .unwrap();
        assert_eq!(t.link_click, TerminalLinkClick::None);
        assert_eq!(t.url_middle_click, TerminalLinkClick::Open);
        assert_eq!(t.font_size, 15);

        let t: TerminalSettings =
            serde_json::from_str(r#"{ "linkClick": "open", "urlMiddleClick": "actions" }"#)
                .unwrap();
        assert_eq!(t.link_click, TerminalLinkClick::Open);
        assert_eq!(t.url_middle_click, TerminalLinkClick::Actions);
    }

    #[test]
    fn terminal_look_keys_missing_from_an_old_file_read_as_defaults() {
        let t: TerminalSettings =
            serde_json::from_str(r#"{ "fontSize": 15, "theme": "nord" }"#).unwrap();
        assert_eq!((t.font_size, t.theme.as_str()), (15, "nord"));
        assert_eq!(t.theme_light, "one-light");
        assert!(!t.theme_follow_app && !t.dim_inactive_panes);
        assert_eq!(t.pane_divider_px, 1);
        assert_eq!(t.font_weight_bold, FontWeightBold::Bold);
        assert!(t.scroll_on_input);
        assert_eq!((t.padding_px, t.background_opacity), (8, 1.0));
        assert_eq!(
            TerminalSettings {
                font_size: 15,
                theme: "nord".into(),
                ..TerminalSettings::default()
            },
            t
        );
        // A whole old settings file, with no terminal look keys at all.
        let all: Settings =
            serde_json::from_str(r#"{ "terminal": { "scrollback": 500 } }"#).unwrap();
        assert_eq!(all.terminal.scrollback, 500);
        assert_eq!(all.terminal.padding_px, 8);
    }

    #[test]
    fn terminal_look_bad_values_cost_only_themselves() {
        let t: TerminalSettings = serde_json::from_str(
            r#"{ "themeLight": 5, "themeFollowApp": "yes", "dimInactivePanes": [],
                 "paneDividerPx": "x", "fontWeightBold": "heavy", "scrollOnInput": null,
                 "paddingPx": -3, "backgroundOpacity": {}, "fontSize": 17 }"#,
        )
        .unwrap();
        let d = TerminalSettings::default();
        assert_eq!(t.theme_light, d.theme_light);
        assert!(!t.theme_follow_app && !t.dim_inactive_panes);
        assert_eq!(t.pane_divider_px, d.pane_divider_px);
        assert_eq!(t.font_weight_bold, FontWeightBold::Bold);
        assert!(t.scroll_on_input);
        assert_eq!((t.padding_px, t.background_opacity), (8, 1.0));
        assert_eq!(t.font_size, 17);
        let t: TerminalSettings = serde_json::from_str(r#"{ "fontWeightBold": "700" }"#).unwrap();
        assert_eq!(t.font_weight_bold, FontWeightBold::W700);
    }

    #[test]
    fn terminal_look_numbers_clamp() {
        let with = |divider, padding, opacity| {
            TerminalSettings {
                pane_divider_px: divider,
                padding_px: padding,
                background_opacity: opacity,
                ..TerminalSettings::default()
            }
            .clamped()
        };
        let hi = with(99, 99, 9.0);
        assert_eq!(
            (hi.pane_divider_px, hi.padding_px, hi.background_opacity),
            (4, 24, 1.0)
        );
        let lo = with(0, 0, 0.0);
        assert_eq!(
            (lo.pane_divider_px, lo.padding_px, lo.background_opacity),
            (1, 0, 0.5)
        );
        assert_eq!(with(2, 12, f32::NAN).background_opacity, 1.0);
        let fine = TerminalSettings {
            pane_divider_px: 3,
            padding_px: 12,
            background_opacity: 0.75,
            theme_light: "gruvbox-light".into(),
            ..TerminalSettings::default()
        };
        assert_eq!(fine.clone().clamped(), fine);
        // A bad light theme id falls back to the light default, not to "app".
        let bad = TerminalSettings {
            theme_light: "No Such!".into(),
            ..TerminalSettings::default()
        };
        assert_eq!(bad.clamped().theme_light, "one-light");
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

    #[test]
    fn capture_settings_default_and_stay_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let want = CaptureSettings::default();
        assert!(want.enabled && !want.annotate_paste);
        assert_eq!(want.shortcut, "CmdOrCtrl+Alt+Shift+S");
        for text in [
            "{}",
            r#"{ "capture": {} }"#,
            r#"{ "capture": 3 }"#,
            r#"{ "capture": { "enabled": "yes" } }"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path).capture, want, "{text}");
        }
        fs::write(
            &path,
            r#"{ "capture": { "annotatePaste": true, "shortcut": "Ctrl+Shift+P" } }"#,
        )
        .unwrap();
        let loaded = load(&path).capture;
        assert!(loaded.enabled && loaded.annotate_paste);
        assert_eq!(loaded.shortcut, "Ctrl+Shift+P");
    }
}

#[cfg(test)]
mod speech_settings_tests {
    use super::*;

    #[test]
    fn speech_settings_default() {
        let s = SpeechSettings::default();
        assert_eq!(s.mode, SpeechMode::Toggle);
        assert_eq!(s.device, None);
        assert_eq!(s.language, None);
        assert_eq!(s.model, "gpt-4o-mini-transcribe");
    }

    #[test]
    fn speech_settings_stay_lenient() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{ "speech": { "mode": "bogus", "device": "USB Mic", "language": "vi", "model": "whisper-1" } }"#,
        )
        .unwrap();
        let s = load(&path).speech;
        assert_eq!(s.mode, SpeechMode::Toggle);
        assert_eq!(s.device.as_deref(), Some("USB Mic"));
        assert_eq!(s.language.as_deref(), Some("vi"));
        assert_eq!(s.model, "whisper-1");
        fs::write(&path, r#"{ "speech": { "mode": "hold" } }"#).unwrap();
        assert_eq!(load(&path).speech.mode, SpeechMode::Hold);
        fs::write(&path, r#"{ "speech": 3 }"#).unwrap();
        assert_eq!(load(&path).speech, SpeechSettings::default());
    }

    #[test]
    fn settings_roundtrip_has_no_key() {
        let settings = Settings {
            speech: SpeechSettings {
                mode: SpeechMode::Hold,
                device: Some("Mic".to_owned()),
                language: Some("en".to_owned()),
                model: "whisper-1".to_owned(),
            },
            ..Settings::default()
        };
        let json = serde_json::to_value(&settings).unwrap();
        let speech = json["speech"].as_object().unwrap();
        let mut fields: Vec<&str> = speech.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, ["device", "language", "mode", "model"]);
        let text = json["speech"].to_string().to_lowercase();
        assert!(!text.contains("key"));
        assert!(!text.contains("apikey"));
    }
}

#[cfg(test)]
mod channel_gate_tests {
    use super::*;

    #[test]
    fn free_to_rc_is_rejected() {
        let e = check_channel(UpdateChannel::Stable, UpdateChannel::Rc, false).unwrap_err();
        assert_eq!(e.code, "license_required");
    }

    #[test]
    fn pro_to_rc_is_allowed() {
        assert!(check_channel(UpdateChannel::Stable, UpdateChannel::Rc, true).is_ok());
    }

    #[test]
    fn an_existing_rc_is_kept_without_pro() {
        assert!(check_channel(UpdateChannel::Rc, UpdateChannel::Rc, false).is_ok());
    }

    #[test]
    fn stable_is_always_allowed() {
        assert!(check_channel(UpdateChannel::Rc, UpdateChannel::Stable, false).is_ok());
        assert!(check_channel(UpdateChannel::Stable, UpdateChannel::Stable, false).is_ok());
    }
}
