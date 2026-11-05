//! Settings → MCP: which app tools `xdev mcp` serves, the log of its recent
//! calls, and a check that the server binary runs. The switches live in
//! `mcp-tools.json` beside `settings.json`; the server process reads the same
//! file on every request, so a change applies without restarting an agent.
//! The log is written by the server processes, never by the app.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use xdev_mcp::{ACTIVITY_FILE, ActivityLog, SETTINGS_FILE, ToolSettings, app_tools};

use crate::commands::CmdError;

/// How long `xdev --version` may take before the server counts as not running.
const CHECK_WAIT: Duration = Duration::from_secs(5);

static WRITE: Mutex<()> = Mutex::new(());

/// One switch as the page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(rename_all = "camelCase"))]
pub struct McpToolView {
    pub name: String,
    /// Writes to the app or reads terminal text.
    pub sensitive: bool,
    pub default_on: bool,
    pub enabled: bool,
}

/// One logged call. There is no field for arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(rename_all = "camelCase"))]
pub struct McpActivityView {
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: u64,
    pub tool: String,
    pub ok: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub duration_ms: u64,
}

/// What the server check found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(rename_all = "camelCase"))]
pub struct McpHealth {
    /// The `xdev` that ships beside the app, and its path; none in a dev build without it.
    pub path: Option<String>,
    /// What `xdev --version` printed, when it ran.
    pub version: Option<String>,
    /// `--version` ran and exited cleanly.
    pub running: bool,
}

fn settings_path() -> Option<PathBuf> {
    xdev_core::config_dir().map(|d| d.join(SETTINGS_FILE))
}

fn activity_path() -> Option<PathBuf> {
    xdev_core::local_dir().map(|d| d.join(ACTIVITY_FILE))
}

fn io_error(e: impl ToString) -> CmdError {
    CmdError {
        code: "mcp_io",
        detail: Some(e.to_string()),
    }
}

fn load(path: Option<&Path>) -> ToolSettings {
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| ToolSettings::parse(&t))
        .unwrap_or_default()
}

pub(crate) fn view(settings: &ToolSettings) -> Vec<McpToolView> {
    app_tools::TOOLS
        .iter()
        .map(|t| McpToolView {
            name: t.name.to_owned(),
            sensitive: t.sensitive,
            default_on: t.default_on,
            enabled: settings.enabled(t.name),
        })
        .collect()
}

/// Sets one switch. A tool that is not one of ours is refused, so the file
/// never collects stray names.
pub(crate) fn set_switch(
    settings: &mut ToolSettings,
    tool: &str,
    enabled: bool,
) -> Result<(), CmdError> {
    let known = app_tools::find(tool).ok_or(CmdError {
        code: "mcp_unknown_tool",
        detail: Some(tool.to_owned()),
    })?;
    // Back at the default means no entry, so a later default change still applies.
    if known.default_on == enabled {
        settings.tools.remove(tool);
    } else {
        settings.tools.insert(tool.to_owned(), enabled);
    }
    Ok(())
}

/// Newest first, as the page lists them.
pub(crate) fn activity_view(log: &ActivityLog) -> Vec<McpActivityView> {
    log.entries
        .iter()
        .rev()
        .map(|e| McpActivityView {
            at_ms: e.at_ms,
            tool: e.tool.clone(),
            ok: e.ok,
            duration_ms: e.duration_ms,
        })
        .collect()
}

/// `xdev 0.7.0` → `0.7.0`; one line, no longer than a version.
pub(crate) fn parse_version(out: &str) -> Option<String> {
    let line = out.lines().next()?.trim();
    let v = line.strip_prefix("xdev ").unwrap_or(line).trim();
    (!v.is_empty() && v.len() <= 64).then(|| v.to_owned())
}

fn run_version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let (tx, rx) = mpsc::channel();
    // A hung binary must not hang the page: the thread is left behind at the deadline.
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output().ok().filter(|o| o.status.success()));
    });
    let out = rx.recv_timeout(CHECK_WAIT).ok().flatten()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command(async)]
pub fn mcp_tools_get() -> Vec<McpToolView> {
    view(&load(settings_path().as_deref()))
}

#[tauri::command(async)]
pub fn mcp_tool_set(tool: String, enabled: bool) -> Result<Vec<McpToolView>, CmdError> {
    let path = settings_path().ok_or_else(|| io_error("no config folder"))?;
    let _held = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(Some(&path));
    set_switch(&mut settings, &tool, enabled)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io_error)?;
    }
    crate::atomic::write_atomic(&path, settings.to_json().as_bytes()).map_err(io_error)?;
    Ok(view(&settings))
}

#[tauri::command(async)]
pub fn mcp_activity() -> Vec<McpActivityView> {
    let log = activity_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| ActivityLog::parse(&t))
        .unwrap_or_default();
    activity_view(&log)
}

/// Runs the bundled `xdev --version`: the binary agents start as `xdev mcp`.
#[tauri::command(async)]
pub fn mcp_health() -> McpHealth {
    let bin = std::env::current_exe()
        .ok()
        .and_then(|exe| crate::commands::cli_beside(&exe));
    let version = bin.as_deref().and_then(run_version);
    McpHealth {
        path: bin.map(|b| b.display().to_string()),
        running: version.is_some(),
        version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_mcp::ActivityEntry;

    #[test]
    fn the_view_lists_every_tool_with_its_default() {
        let v = view(&ToolSettings::default());
        assert_eq!(v.len(), app_tools::TOOLS.len());
        let on: Vec<&str> = v
            .iter()
            .filter(|t| t.enabled)
            .map(|t| t.name.as_str())
            .collect();
        assert_eq!(on, ["list_tabs", "list_worktrees", "list_ports"]);
        assert!(
            v.iter()
                .find(|t| t.name == "send_to_tab")
                .unwrap()
                .sensitive
        );
        assert!(!v.iter().find(|t| t.name == "list_tabs").unwrap().sensitive);
    }

    #[test]
    fn a_switch_set_back_to_its_default_leaves_no_entry() {
        let mut s = ToolSettings::default();
        set_switch(&mut s, "send_to_tab", true).unwrap();
        assert!(s.enabled("send_to_tab"));
        assert_eq!(s.tools.len(), 1);
        set_switch(&mut s, "send_to_tab", false).unwrap();
        assert!(s.tools.is_empty());
        set_switch(&mut s, "list_tabs", false).unwrap();
        assert!(!s.enabled("list_tabs"));
        assert_eq!(
            set_switch(&mut s, "rm_rf", true).unwrap_err().code,
            "mcp_unknown_tool"
        );
        assert_eq!(s.tools.len(), 1);
    }

    #[test]
    fn activity_is_newest_first_and_carries_no_arguments() {
        let log = ActivityLog {
            entries: (1..=3)
                .map(|n| ActivityEntry {
                    at_ms: n,
                    tool: "send_to_tab".into(),
                    ok: n != 2,
                    duration_ms: 5,
                })
                .collect(),
        };
        let v = activity_view(&log);
        assert_eq!(v.iter().map(|e| e.at_ms).collect::<Vec<_>>(), [3, 2, 1]);
        assert!(!v[1].ok);
        assert_eq!(
            serde_json::to_value(&v[0]).unwrap(),
            serde_json::json!({"atMs": 3, "tool": "send_to_tab", "ok": true, "durationMs": 5})
        );
    }

    #[test]
    fn version_output_is_read_from_its_first_line() {
        assert_eq!(parse_version("xdev 0.7.0\n").as_deref(), Some("0.7.0"));
        assert_eq!(parse_version("0.7.0").as_deref(), Some("0.7.0"));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version(&"x".repeat(200)), None);
    }
}
