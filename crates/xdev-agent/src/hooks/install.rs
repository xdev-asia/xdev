//! Managed status hooks: for a CLI that takes hooks only from its own
//! config, `install_hooks` writes xDev's hooks there and `uninstall_hooks`
//! takes them out again. Three ways, by what the CLI reads ([`Store`]):
//!
//! - entries merged into the `hooks` of the person's settings file, each
//!   named [`NAME_PREFIX`]… (gemini);
//! - one top-level key, [`HOOK_KEY`], of a hooks file the person shares
//!   (antigravity);
//! - a whole file of xDev's own beside the person's (copilot's hook file,
//!   opencode's and kilo's plugin).
//!
//! Only what xDev wrote is changed; every other key, entry and order stays
//! as it was. A shared file that is not plain JSON (say, with comments) and
//! a file at xDev's own path that xDev did not write are left alone and
//! reported as errors. Files are replaced atomically.
//!
//! Checked on 2026-11-06, macOS, from the CLI's docs and source on this
//! machine. None of these CLIs was run, so [Unverified] each event seen
//! firing and the hook getting `XDEV_PTY_ID` where not stated below:
//!
//! - `gemini` 0.63.0 (`bundle/docs/hooks/index.md`, `reference.md`, the
//!   bundled source): `<root>/.gemini/settings.json`, `<root>` being
//!   `GEMINI_CLI_HOME` or else the user's home, holds
//!   `{"hooks":{"<Event>":[{"matcher"?,"hooks":[{"name","type":"command","command","timeout"}]}]}}`
//!   with `timeout` in milliseconds. The hook JSON comes on stdin; stdout
//!   must be JSON or nothing (`xdev agent-hook` prints nothing). The hook
//!   gets the CLI's environment (`sanitizeEnvironment` keeps every variable
//!   unless redaction is on, and then drops only secret-like names), so
//!   `XDEV_PTY_ID` reaches it.
//! - `copilot` 1.0.95 (the changelog, `api.schema.json` and strings of the
//!   bundle packed in its binary): personal hooks are `~/.copilot/hooks/*.json`,
//!   `{"version":1,"hooks":{"<event>":[{"type":"command","bash"|"powershell","timeoutSec"}]}}`,
//!   events `userPromptSubmitted`, `permissionRequest`, `postToolUse`,
//!   `agentStop`. `COPILOT_HOME` replaces `~/.copilot`; [Inference] that the
//!   hooks folder moves with it.
//! - `agy` (antigravity, `builtin/skills/agy-customizations/docs/hooks.md`):
//!   `~/.gemini/config/hooks.json` maps a hook name to
//!   `{"PreInvocation":[{"type":"command","command","timeout"}],"Stop":[…]}`,
//!   `timeout` in seconds, run with `sh -c`; stdout must be a JSON object,
//!   hence the `echo '{}'`. It has no prompt or permission event:
//!   `PreInvocation` (before each model call) stands in for the prompt.
//!   Not managed on Windows, where the `cmd /c` quoting was not checked.
//! - `opencode` 1.18.35 and `kilo` 7.8.8, a fork (strings of the binaries):
//!   no shell hooks; every `plugin/*.js` of the global config folder
//!   (`OPENCODE_CONFIG_DIR` / `KILO_CONFIG_DIR`, else
//!   `$XDG_CONFIG_HOME/<cli>` or `~/.config/<cli>`) is loaded, and its
//!   exported function returns the hooks: `chat.message` and `event`, which
//!   gets the bus events `permission.asked`, `permission.replied` and
//!   `session.idle`. [Unverified] that `session.idle` of a sub-agent's
//!   session does not come before the turn's end.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{HookEvent, events_of};
use crate::codex_home::hook_command;
use crate::profiles::Cli;

/// The start of the `name` of every hook entry xDev merges into a settings
/// file; how its own entries are told from the person's.
pub const NAME_PREFIX: &str = "xdev-status:";

/// The name of xDev's hook in a shared hooks file, and of its own files.
pub const HOOK_KEY: &str = "xdev-status";

/// How a CLI gets xDev's status hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HookSupport {
    /// Passed with each start (flags, a private home); nothing to install.
    Launch,
    /// Written into the CLI's own config by [`install_hooks`].
    Managed,
    /// No hook xDev can use; `reason` says why.
    Unsupported { reason: Unsupported },
}

/// Why a CLI has no status hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum Unsupported {
    /// No hook mechanism could be confirmed: the CLI was not installed
    /// where the check ran, or its hooks were not checked on this system.
    NotChecked,
}

/// Whether xDev's managed hooks are in a CLI's config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum HookInstall {
    /// None of xDev's hooks.
    Missing,
    /// Exactly the hooks [`install_hooks`] writes for this `xdev`.
    Installed,
    /// Some of xDev's hooks, but not the current set (another `xdev`
    /// path, an older event list): installing again fixes it.
    Outdated,
}

/// How `cli` gets its status hooks.
pub fn hook_support(cli: Cli) -> HookSupport {
    match store(cli) {
        Some(_) => HookSupport::Managed,
        None if matches!(cli, Cli::Claude | Cli::Codex) => HookSupport::Launch,
        None => HookSupport::Unsupported {
            reason: Unsupported::NotChecked,
        },
    }
}

/// Where a managed CLI keeps xDev's hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Store {
    /// Entries in the `hooks` of the person's settings.
    Settings,
    /// The [`HOOK_KEY`] of a hooks file the person shares.
    NamedKey,
    /// A file only xDev writes.
    OwnFile,
}

fn store(cli: Cli) -> Option<Store> {
    match cli {
        Cli::Gemini => Some(Store::Settings),
        Cli::Antigravity if !cfg!(windows) => Some(Store::NamedKey),
        Cli::Copilot | Cli::Opencode | Cli::Kilo => Some(Store::OwnFile),
        _ => None,
    }
}

/// One managed hook: the CLI's event, its matcher and the
/// `xdev agent-hook` event it writes.
struct Managed {
    event: &'static str,
    matcher: Option<&'static str>,
    writes: &'static str,
}

const fn hook(event: &'static str, writes: &'static str) -> Managed {
    Managed {
        event,
        matcher: None,
        writes,
    }
}

/// How long a gemini hook may run, in milliseconds; any other, in seconds.
const GEMINI_TIMEOUT_MS: u64 = 10_000;
const TIMEOUT_SECS: u64 = 10;

/// `BeforeAgent` comes after the person sends a prompt; `Notification`
/// (`ToolPermission`) when a tool waits for approval; `AfterTool` after a
/// tool ran, which is also the end of an approval; `AfterAgent` once per
/// turn, after the final answer.
const GEMINI_HOOKS: [Managed; 4] = [
    hook("BeforeAgent", "prompt"),
    Managed {
        event: "Notification",
        matcher: Some("*"),
        writes: "needs-input",
    },
    Managed {
        event: "AfterTool",
        matcher: Some("*"),
        writes: "resume",
    },
    hook("AfterAgent", "turn-done"),
];

/// [Unverified] that `permissionRequest` fires only when the person is
/// asked; a `postToolUse` after it says the turn goes on either way.
const COPILOT_HOOKS: [Managed; 4] = [
    hook("userPromptSubmitted", "prompt"),
    hook("permissionRequest", "needs-input"),
    hook("postToolUse", "resume"),
    hook("agentStop", "turn-done"),
];

const ANTIGRAVITY_HOOKS: [Managed; 2] =
    [hook("PreInvocation", "prompt"), hook("Stop", "turn-done")];

/// `chat.message` is a plugin hook; the rest are bus events.
const PLUGIN_HOOKS: [Managed; 4] = [
    hook("chat.message", "prompt"),
    hook("permission.asked", "needs-input"),
    hook("permission.replied", "resume"),
    hook("session.idle", "turn-done"),
];

fn managed(cli: Cli) -> &'static [Managed] {
    match (cli, store(cli)) {
        (_, None) => &[],
        (Cli::Gemini, _) => &GEMINI_HOOKS,
        (Cli::Copilot, _) => &COPILOT_HOOKS,
        (Cli::Antigravity, _) => &ANTIGRAVITY_HOOKS,
        (Cli::Opencode | Cli::Kilo, _) => &PLUGIN_HOOKS,
        _ => &[],
    }
}

/// The events installed managed hooks make `cli` report; empty for a CLI
/// without them.
pub fn managed_events(cli: Cli) -> Vec<HookEvent> {
    events_of(managed(cli).iter().map(|h| h.writes))
}

/// The file the managed hooks of `cli` go in, under the `root`
/// [`hooks_root`] gives. `None` for a CLI without managed hooks.
pub fn hooks_settings(cli: Cli, root: &Path) -> Option<PathBuf> {
    store(cli)?;
    Some(match cli {
        Cli::Gemini => root.join(".gemini").join("settings.json"),
        Cli::Antigravity => root.join(".gemini").join("config").join("hooks.json"),
        Cli::Copilot => root.join("hooks").join(format!("{HOOK_KEY}.json")),
        _ => root.join("plugin").join(format!("{HOOK_KEY}.js")),
    })
}

/// The root [`hooks_settings`] takes for `cli`, from `var` (the launch's or
/// the process's environment): for gemini `GEMINI_CLI_HOME` or the user's
/// home, for antigravity the home, for copilot `COPILOT_HOME` or
/// `~/.copilot`, for opencode and kilo their global config folder. An empty
/// variable counts as unset.
pub fn hooks_root(cli: Cli, var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    store(cli)?;
    let set = |key: &str| var(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = || set(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let config = |name: &str| {
        set("XDG_CONFIG_HOME")
            .or_else(|| home().map(|h| h.join(".config")))
            .map(|c| c.join(name))
    };
    match cli {
        Cli::Gemini => set("GEMINI_CLI_HOME").or_else(home),
        Cli::Copilot => set("COPILOT_HOME").or_else(|| home().map(|h| h.join(".copilot"))),
        Cli::Opencode => set("OPENCODE_CONFIG_DIR").or_else(|| config("opencode")),
        Cli::Kilo => set("KILO_CONFIG_DIR").or_else(|| config("kilo")),
        _ => home(),
    }
}

/// Whether xDev's hooks are in the config of `cli` under `root`, for an
/// `xdev` at `xdev`. A missing file is [`HookInstall::Missing`]; a shared
/// file that is not a JSON object is an `InvalidData` error, a file at
/// xDev's own path that xDev did not write an `AlreadyExists` one.
pub fn hook_install_state(cli: Cli, root: &Path, xdev: &Path) -> io::Result<HookInstall> {
    let path = hooks_settings(cli, root).ok_or_else(not_managed)?;
    let state = |installed: bool| {
        if installed {
            HookInstall::Installed
        } else {
            HookInstall::Outdated
        }
    };
    match store(cli).ok_or_else(not_managed)? {
        Store::Settings => {
            let Some(settings) = read_settings(&path)? else {
                return Ok(HookInstall::Missing);
            };
            let mut have = ours_in(&settings);
            if have.is_empty() {
                return Ok(HookInstall::Missing);
            }
            let mut want = wanted(cli, xdev);
            want.sort();
            have.sort();
            Ok(state(want == have))
        }
        Store::NamedKey => {
            let settings = read_settings(&path)?.unwrap_or_default();
            Ok(match settings.get(HOOK_KEY) {
                None => HookInstall::Missing,
                Some(have) => state(*have == named_hook(cli, xdev)),
            })
        }
        Store::OwnFile => Ok(match read_own(&path)? {
            None => HookInstall::Missing,
            Some(have) => state(have == own_file(cli, xdev)),
        }),
    }
}

/// Writes xDev's hooks for `cli` under `root`: earlier xDev hooks go, the
/// current ones come, nothing else changes. Running it twice leaves the
/// files as after once.
pub fn install_hooks(cli: Cli, root: &Path, xdev: &Path) -> io::Result<()> {
    let path = hooks_settings(cli, root).ok_or_else(not_managed)?;
    let text = match store(cli).ok_or_else(not_managed)? {
        Store::Settings => {
            let mut settings = read_settings(&path)?.unwrap_or_default();
            let before = settings.clone();
            merge_ours(cli, xdev, &mut settings)?;
            if settings == before {
                return Ok(());
            }
            json_text(&settings)?
        }
        Store::NamedKey => {
            let mut settings = read_settings(&path)?.unwrap_or_default();
            let hook = named_hook(cli, xdev);
            if settings.get(HOOK_KEY) == Some(&hook) {
                return Ok(());
            }
            // An earlier one keeps its place.
            settings.insert(HOOK_KEY.to_owned(), hook);
            json_text(&settings)?
        }
        Store::OwnFile => {
            let text = own_file(cli, xdev);
            if read_own(&path)?.as_deref() == Some(text.as_str()) {
                return Ok(());
            }
            text
        }
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    write_atomic(&path, &text)
}

/// Takes xDev's hooks out of the config of `cli` under `root`: its entries
/// and any group, event list or `hooks` object left empty by that, its key,
/// or its own file. Without them (or without a file) nothing is written.
pub fn uninstall_hooks(cli: Cli, root: &Path) -> io::Result<()> {
    let path = hooks_settings(cli, root).ok_or_else(not_managed)?;
    match store(cli).ok_or_else(not_managed)? {
        Store::Settings => {
            let Some(mut settings) = read_settings(&path)? else {
                return Ok(());
            };
            if strip_ours(&mut settings) {
                write_atomic(&path, &json_text(&settings)?)?;
            }
        }
        Store::NamedKey => {
            let Some(mut settings) = read_settings(&path)? else {
                return Ok(());
            };
            if settings.shift_remove(HOOK_KEY).is_some() {
                write_atomic(&path, &json_text(&settings)?)?;
            }
        }
        Store::OwnFile => {
            if read_own(&path)?.is_some() {
                fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}

fn not_managed() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "this CLI takes no managed hooks",
    )
}

/// The settings object, `None` when there is no file. An empty file counts
/// as `{}`.
fn read_settings(path: &Path) -> io::Result<Option<Map<String, Value>>> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    if text.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    match serde_json::from_str(&text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the settings file is not a plain JSON object",
        )),
    }
}

fn read_text(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// What every file of xDev's own holds, and a file of the person's at that
/// path hardly would.
const OWN_MARK: &str = "agent-hook";

/// xDev's own file at `path`, `None` when there is none. A file there that
/// xDev did not write is an `AlreadyExists` error.
fn read_own(path: &Path) -> io::Result<Option<String>> {
    match read_text(path)? {
        Some(text) if !text.contains(OWN_MARK) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} is not xDev's", path.display()),
        )),
        text => Ok(text),
    }
}

fn json_text(value: &Map<String, Value>) -> io::Result<String> {
    let mut text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    text.push('\n');
    Ok(text)
}

/// Writes `text` through a temporary file in the same folder, so the CLI
/// never reads half a file.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(
        ".{name}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Adds the current entries to the settings' `hooks`, after taking out
/// earlier ones.
fn merge_ours(cli: Cli, xdev: &Path, settings: &mut Map<String, Value>) -> io::Result<()> {
    strip_ours(settings);
    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(hooks) = hooks.as_object_mut() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "`hooks` in the settings is not an object",
        ));
    };
    for hook in managed(cli) {
        let groups = hooks
            .entry(hook.event)
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(groups) = groups.as_array_mut() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("`hooks.{}` in the settings is not a list", hook.event),
            ));
        };
        let mut group = json!({ "hooks": [{
            "name": format!("{NAME_PREFIX}{}", hook.writes),
            "type": "command",
            "command": hook_command(xdev, hook.writes),
            "timeout": GEMINI_TIMEOUT_MS,
        }] });
        if let Some(matcher) = hook.matcher {
            // The matcher goes first, as in the CLI's docs.
            group = json!({ "matcher": matcher, "hooks": group["hooks"].take() });
        }
        groups.push(group);
    }
    Ok(())
}

/// The value of [`HOOK_KEY`] in antigravity's hooks file. Its stdout must
/// be a JSON object, so each command ends with `echo '{}'`.
fn named_hook(cli: Cli, xdev: &Path) -> Value {
    let mut hook = Map::new();
    for h in managed(cli) {
        let command = format!("{}; echo '{{}}'", hook_command(xdev, h.writes));
        hook.insert(
            h.event.to_owned(),
            json!([{ "type": "command", "command": command, "timeout": TIMEOUT_SECS }]),
        );
    }
    Value::Object(hook)
}

/// The whole of xDev's own file for `cli`.
fn own_file(cli: Cli, xdev: &Path) -> String {
    match cli {
        Cli::Copilot => copilot_file(xdev),
        _ => plugin_file(cli, xdev),
    }
}

/// Copilot's hook file. Its hooks run in bash, or PowerShell on Windows.
fn copilot_file(xdev: &Path) -> String {
    let shell = if cfg!(windows) { "powershell" } else { "bash" };
    let mut hooks = Map::new();
    for h in &COPILOT_HOOKS {
        let mut handler = Map::new();
        handler.insert("type".to_owned(), json!("command"));
        handler.insert(shell.to_owned(), json!(hook_command(xdev, h.writes)));
        handler.insert("timeoutSec".to_owned(), json!(TIMEOUT_SECS));
        hooks.insert(h.event.to_owned(), json!([handler]));
    }
    let mut file = Map::new();
    file.insert("version".to_owned(), json!(1));
    file.insert("hooks".to_owned(), Value::Object(hooks));
    json_text(&file).unwrap_or_default()
}

/// The opencode (and kilo) plugin: it runs `xdev agent-hook` itself, with
/// no shell, only in a pane xDev started (`XDEV_PTY_ID`), and never waits
/// for it.
fn plugin_file(cli: Cli, xdev: &Path) -> String {
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut events = String::new();
    for h in PLUGIN_HOOKS.iter().filter(|h| h.event != "chat.message") {
        events.push_str(&format!("  {}: {},\n", quote(h.event), quote(h.writes)));
    }
    format!(
        r#"// xDev status hooks for {cli}: runs `xdev agent-hook <event>` so the xDev
// tab shows when the agent works, waits and is done. Written by xDev;
// remove it in xDev's settings (Agents, Status hooks).
import {{ spawn }} from "node:child_process";

const XDEV = {xdev};
const EVENTS = {{
{events}}};

function report(event) {{
  if (!process.env.XDEV_PTY_ID) return;
  try {{
    const child = spawn(XDEV, ["agent-hook", event], {{ stdio: "ignore", windowsHide: true }});
    child.on("error", () => {{}});
    child.unref();
  }} catch {{}}
}}

export const XdevStatus = async () => ({{
  "chat.message": async () => report("prompt"),
  event: async ({{ event }}) => {{
    const name = EVENTS[event?.type];
    if (name) report(name);
  }},
}});
"#,
        cli = cli.as_str(),
        xdev = quote(&xdev.to_string_lossy()),
    )
}

/// Whether a hook entry is one xDev wrote.
fn is_ours(entry: &Value) -> bool {
    entry
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|n| n.starts_with(NAME_PREFIX))
}

/// Each xDev entry as `(event, matcher, name, command)`.
type Entry = (String, Option<String>, String, String);

fn ours_in(settings: &Map<String, Value>) -> Vec<Entry> {
    let mut out = Vec::new();
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return out;
    };
    for (event, groups) in hooks {
        for group in groups.as_array().into_iter().flatten() {
            let matcher = group.get("matcher").and_then(Value::as_str);
            let entries = group.get("hooks").and_then(Value::as_array);
            for entry in entries.into_iter().flatten().filter(|e| is_ours(e)) {
                let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("");
                out.push((
                    event.clone(),
                    matcher.map(str::to_owned),
                    text("name").to_owned(),
                    text("command").to_owned(),
                ));
            }
        }
    }
    out
}

fn wanted(cli: Cli, xdev: &Path) -> Vec<Entry> {
    managed(cli)
        .iter()
        .map(|h| {
            (
                h.event.to_owned(),
                h.matcher.map(str::to_owned),
                format!("{NAME_PREFIX}{}", h.writes),
                hook_command(xdev, h.writes),
            )
        })
        .collect()
}

/// Removes xDev's entries and whatever that leaves empty; whether anything
/// went.
fn strip_ours(settings: &mut Map<String, Value>) -> bool {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    // Only what this emptied goes: a group or list that was empty already is
    // the person's.
    let mut emptied = Vec::new();
    for (event, groups) in hooks.iter_mut() {
        let Some(list) = groups.as_array_mut() else {
            continue;
        };
        let len = list.len();
        list.retain_mut(|group| {
            let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = entries.len();
            entries.retain(|e| !is_ours(e));
            if entries.len() == before {
                return true;
            }
            changed = true;
            !entries.is_empty()
        });
        if list.is_empty() && len > 0 {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        hooks.shift_remove(&event);
    }
    if changed && hooks.is_empty() {
        settings.shift_remove("hooks");
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const XDEV: &str = "/opt/x dev/xdev";

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn settings_at(root: &Path) -> PathBuf {
        hooks_settings(Cli::Gemini, root).unwrap()
    }

    fn read(root: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(settings_at(root)).unwrap()).unwrap()
    }

    fn write(root: &Path, text: &str) {
        let path = settings_at(root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn every_cli_has_a_support_or_a_reason() {
        for cli in Cli::ALL {
            let support = hook_support(cli);
            let managed = support == HookSupport::Managed;
            assert_eq!(managed, !managed_events(cli).is_empty(), "{cli:?}");
            assert_eq!(
                managed,
                hooks_settings(cli, Path::new("/r")).is_some(),
                "{cli:?}"
            );
        }
        assert_eq!(hook_support(Cli::Claude), HookSupport::Launch);
        assert_eq!(
            hook_support(Cli::QwenCode),
            HookSupport::Unsupported {
                reason: Unsupported::NotChecked
            }
        );
    }

    #[test]
    fn support_serializes_with_its_kind() {
        let text = serde_json::to_string(&hook_support(Cli::Aider)).unwrap();
        assert_eq!(text, r#"{"kind":"unsupported","reason":"not-checked"}"#);
        let text = serde_json::to_string(&HookSupport::Managed).unwrap();
        assert_eq!(text, r#"{"kind":"managed"}"#);
    }

    #[test]
    fn gemini_reports_four_events() {
        use HookEvent::*;
        assert_eq!(
            managed_events(Cli::Gemini),
            [Prompt, NeedsInput, Resume, TurnDone]
        );
        assert!(managed_events(Cli::Claude).is_empty());
    }

    #[test]
    fn root_is_gemini_cli_home_else_home() {
        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| std::ffi::OsString::from(v))
            }
        };
        let both: &'static [(&str, &str)] = if cfg!(windows) {
            &[("GEMINI_CLI_HOME", "G"), ("USERPROFILE", "H")]
        } else {
            &[("GEMINI_CLI_HOME", "G"), ("HOME", "H")]
        };
        assert_eq!(hooks_root(Cli::Gemini, env(both)), Some(PathBuf::from("G")));
        let home_only: &'static [(&str, &str)] = if cfg!(windows) {
            &[("GEMINI_CLI_HOME", ""), ("USERPROFILE", "H")]
        } else {
            &[("GEMINI_CLI_HOME", ""), ("HOME", "H")]
        };
        assert_eq!(
            hooks_root(Cli::Gemini, env(home_only)),
            Some(PathBuf::from("H"))
        );
        assert_eq!(hooks_root(Cli::Gemini, env(&[])), None);
        assert_eq!(hooks_root(Cli::Aider, |_| Some(home_key.into())), None);
    }

    #[test]
    fn install_into_no_file_writes_the_hooks() {
        let root = root();
        let xdev = Path::new(XDEV);
        assert_eq!(
            hook_install_state(Cli::Gemini, root.path(), xdev).unwrap(),
            HookInstall::Missing
        );
        install_hooks(Cli::Gemini, root.path(), xdev).unwrap();
        let v = read(root.path());
        let entry = &v["hooks"]["BeforeAgent"][0]["hooks"][0];
        assert_eq!(entry["name"], "xdev-status:prompt");
        assert_eq!(entry["type"], "command");
        assert_eq!(entry["timeout"], 10_000);
        assert_eq!(entry["command"], hook_command(xdev, "prompt"));
        assert_eq!(v["hooks"]["AfterTool"][0]["matcher"], "*");
        assert!(v["hooks"]["AfterAgent"][0].get("matcher").is_none());
        assert_eq!(
            hook_install_state(Cli::Gemini, root.path(), xdev).unwrap(),
            HookInstall::Installed
        );
    }

    #[test]
    fn install_merges_and_keeps_the_persons_settings() {
        let root = root();
        let mine = r#"{
  "theme": "Dracula",
  "hooks": {
    "AfterTool": [
      { "matcher": "write_.*", "hooks": [{ "name": "lint", "type": "command", "command": "lint.sh" }] }
    ]
  },
  "hooksConfig": { "enabled": true }
}"#;
        write(root.path(), mine);
        install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap();
        let v = read(root.path());
        assert_eq!(v["theme"], "Dracula");
        assert_eq!(v["hooksConfig"]["enabled"], true);
        let after = v["hooks"]["AfterTool"].as_array().unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0]["hooks"][0]["name"], "lint");
        assert_eq!(after[1]["hooks"][0]["name"], "xdev-status:resume");
        // The person's keys keep their order.
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["theme", "hooks", "hooksConfig"]);
    }

    #[test]
    fn install_twice_is_install_once() {
        let root = root();
        write(root.path(), r#"{"theme":"x"}"#);
        install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap();
        let once = fs::read_to_string(settings_at(root.path())).unwrap();
        install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap();
        let twice = fs::read_to_string(settings_at(root.path())).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn a_moved_xdev_is_outdated_and_install_replaces_it() {
        let root = root();
        install_hooks(Cli::Gemini, root.path(), Path::new("/old/xdev")).unwrap();
        let new = Path::new(XDEV);
        assert_eq!(
            hook_install_state(Cli::Gemini, root.path(), new).unwrap(),
            HookInstall::Outdated
        );
        install_hooks(Cli::Gemini, root.path(), new).unwrap();
        assert_eq!(
            hook_install_state(Cli::Gemini, root.path(), new).unwrap(),
            HookInstall::Installed
        );
        let v = read(root.path());
        assert_eq!(v["hooks"]["BeforeAgent"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn uninstall_takes_out_only_xdev_entries() {
        let root = root();
        let mine = r#"{"hooks":{"AfterTool":[{"matcher":"*","hooks":[]},{"matcher":"x","hooks":[{"name":"lint","type":"command","command":"lint.sh"}]}]},"theme":"x"}"#;
        write(root.path(), mine);
        install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap();
        uninstall_hooks(Cli::Gemini, root.path()).unwrap();
        assert_eq!(
            read(root.path()),
            serde_json::from_str::<Value>(mine).unwrap()
        );
        assert_eq!(
            hook_install_state(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap(),
            HookInstall::Missing
        );
    }

    #[test]
    fn uninstall_of_only_xdev_hooks_drops_the_hooks_key() {
        let root = root();
        write(root.path(), r#"{"theme":"x"}"#);
        install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap();
        uninstall_hooks(Cli::Gemini, root.path()).unwrap();
        assert_eq!(read(root.path()), json!({ "theme": "x" }));
    }

    #[test]
    fn uninstall_without_a_file_writes_nothing() {
        let root = root();
        uninstall_hooks(Cli::Gemini, root.path()).unwrap();
        assert!(!settings_at(root.path()).exists());
    }

    #[test]
    fn a_file_with_comments_is_never_overwritten() {
        let root = root();
        let text = "{\n  // mine\n  \"theme\": \"x\"\n}\n";
        write(root.path(), text);
        let xdev = Path::new(XDEV);
        let err = install_hooks(Cli::Gemini, root.path(), xdev).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(hook_install_state(Cli::Gemini, root.path(), xdev).is_err());
        assert!(uninstall_hooks(Cli::Gemini, root.path()).is_err());
        assert_eq!(fs::read_to_string(settings_at(root.path())).unwrap(), text);
    }

    #[test]
    fn a_hooks_value_of_the_wrong_shape_is_an_error() {
        let root = root();
        write(root.path(), r#"{"hooks":[]}"#);
        let err = install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        write(root.path(), r#"{"hooks":{"AfterTool":{}}}"#);
        assert!(install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).is_err());
    }

    #[test]
    fn a_cli_without_managed_hooks_is_refused() {
        let root = root();
        let err = install_hooks(Cli::Claude, root.path(), Path::new(XDEV)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Unsupported);
        assert!(uninstall_hooks(Cli::Aider, root.path()).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    /// A root of `cli` inside the temp dir, as `hooks_root` would give it.
    fn root_of(cli: Cli, dir: &Path) -> PathBuf {
        let home = dir.to_path_buf();
        hooks_root(cli, |key| {
            matches!(key, "HOME" | "USERPROFILE").then(|| home.clone().into_os_string())
        })
        .unwrap()
    }

    #[test]
    fn every_managed_cli_installs_once_and_uninstalls_clean() {
        let dir = root();
        let xdev = Path::new(XDEV);
        for cli in Cli::ALL.into_iter().filter(|c| store(*c).is_some()) {
            let root = root_of(cli, dir.path());
            assert!(root.starts_with(dir.path()), "{cli:?}");
            let path = hooks_settings(cli, &root).unwrap();
            assert_eq!(
                hook_install_state(cli, &root, xdev).unwrap(),
                HookInstall::Missing
            );
            install_hooks(cli, &root, xdev).unwrap();
            let once = fs::read_to_string(&path).unwrap();
            install_hooks(cli, &root, xdev).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), once, "{cli:?}");
            assert_eq!(
                hook_install_state(cli, &root, xdev).unwrap(),
                HookInstall::Installed
            );
            uninstall_hooks(cli, &root).unwrap();
            assert_eq!(
                hook_install_state(cli, &root, xdev).unwrap(),
                HookInstall::Missing
            );
            uninstall_hooks(cli, &root).unwrap();
        }
    }

    #[test]
    fn roots_follow_each_clis_variables() {
        let env = |pairs: Vec<(&'static str, &'static str)>| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| std::ffi::OsString::from(v))
            }
        };
        let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let h = Path::new("H");
        assert_eq!(
            hooks_root(Cli::Copilot, env(vec![(home, "H")])),
            Some(h.join(".copilot"))
        );
        assert_eq!(
            hooks_root(Cli::Copilot, env(vec![(home, "H"), ("COPILOT_HOME", "C")])),
            Some(PathBuf::from("C"))
        );
        assert_eq!(
            hooks_root(Cli::Opencode, env(vec![(home, "H")])),
            Some(h.join(".config").join("opencode"))
        );
        assert_eq!(
            hooks_root(Cli::Kilo, env(vec![(home, "H"), ("XDG_CONFIG_HOME", "X")])),
            Some(Path::new("X").join("kilo"))
        );
        assert_eq!(
            hooks_root(
                Cli::Opencode,
                env(vec![(home, "H"), ("OPENCODE_CONFIG_DIR", "O")])
            ),
            Some(PathBuf::from("O"))
        );
        let copilot = hooks_settings(Cli::Copilot, Path::new("C")).unwrap();
        assert_eq!(
            copilot,
            Path::new("C").join("hooks").join("xdev-status.json")
        );
        let kilo = hooks_settings(Cli::Kilo, Path::new("K")).unwrap();
        assert_eq!(kilo, Path::new("K").join("plugin").join("xdev-status.js"));
    }

    #[test]
    fn copilot_file_maps_four_events() {
        let dir = root();
        install_hooks(Cli::Copilot, dir.path(), Path::new(XDEV)).unwrap();
        let path = hooks_settings(Cli::Copilot, dir.path()).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        let shell = if cfg!(windows) { "powershell" } else { "bash" };
        let stop = &v["hooks"]["agentStop"][0];
        assert_eq!(stop["type"], "command");
        assert_eq!(stop[shell], hook_command(Path::new(XDEV), "turn-done"));
        assert_eq!(stop["timeoutSec"], 10);
        let mut events: Vec<_> = v["hooks"].as_object().unwrap().keys().cloned().collect();
        events.sort();
        assert_eq!(
            events,
            [
                "agentStop",
                "permissionRequest",
                "postToolUse",
                "userPromptSubmitted"
            ]
        );
    }

    #[test]
    fn a_file_of_the_persons_at_xdevs_path_is_never_touched() {
        let dir = root();
        let path = hooks_settings(Cli::Copilot, dir.path()).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mine = r#"{"version":1,"hooks":{}}"#;
        fs::write(&path, mine).unwrap();
        let xdev = Path::new(XDEV);
        let err = install_hooks(Cli::Copilot, dir.path(), xdev).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        let err = hook_install_state(Cli::Copilot, dir.path(), xdev).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(uninstall_hooks(Cli::Copilot, dir.path()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), mine);
    }

    #[test]
    fn an_own_file_of_another_xdev_is_outdated() {
        let dir = root();
        install_hooks(Cli::Opencode, dir.path(), Path::new("/old/xdev")).unwrap();
        let xdev = Path::new(XDEV);
        assert_eq!(
            hook_install_state(Cli::Opencode, dir.path(), xdev).unwrap(),
            HookInstall::Outdated
        );
        install_hooks(Cli::Opencode, dir.path(), xdev).unwrap();
        assert_eq!(
            hook_install_state(Cli::Opencode, dir.path(), xdev).unwrap(),
            HookInstall::Installed
        );
    }

    #[test]
    fn the_plugin_runs_xdev_without_a_shell() {
        let text = plugin_file(Cli::Kilo, Path::new(r#"/opt/a "b"/xdev"#));
        assert!(
            text.contains(r#"const XDEV = "/opt/a \"b\"/xdev";"#),
            "{text}"
        );
        assert!(text.contains(r#"spawn(XDEV, ["agent-hook", event]"#));
        assert!(text.contains("process.env.XDEV_PTY_ID"));
        assert!(text.contains(r#""session.idle": "turn-done","#));
        assert!(text.contains(r#""chat.message": async () => report("prompt")"#));
        assert!(text.contains("export const XdevStatus"));
    }

    #[test]
    fn plugin_clis_report_four_events() {
        use HookEvent::*;
        for cli in [Cli::Opencode, Cli::Kilo, Cli::Copilot] {
            assert_eq!(managed_events(cli), [Prompt, NeedsInput, Resume, TurnDone]);
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn antigravity_adds_one_named_hook_beside_the_persons() {
        let dir = root();
        let path = hooks_settings(Cli::Antigravity, dir.path()).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mine = r#"{"lint":{"PostToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"x"}]}]},"zz":{"Stop":[]}}"#;
        fs::write(&path, mine).unwrap();
        install_hooks(Cli::Antigravity, dir.path(), Path::new(XDEV)).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["lint", "zz", "xdev-status"]);
        let stop = &v["xdev-status"]["Stop"][0];
        assert_eq!(
            stop["command"],
            "'/opt/x dev/xdev' agent-hook turn-done; echo '{}'"
        );
        assert_eq!(stop["timeout"], 10);
        assert_eq!(
            managed_events(Cli::Antigravity),
            [HookEvent::Prompt, HookEvent::TurnDone]
        );
        uninstall_hooks(Cli::Antigravity, dir.path()).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v, serde_json::from_str::<Value>(mine).unwrap());
    }

    #[test]
    fn no_temp_file_is_left_behind() {
        let root = root();
        install_hooks(Cli::Gemini, root.path(), Path::new(XDEV)).unwrap();
        let dir = settings_at(root.path()).parent().unwrap().to_path_buf();
        let names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["settings.json"]);
    }
}
