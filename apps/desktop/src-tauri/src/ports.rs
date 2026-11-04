//! Local ports: the scan the Ports panel shows, stopping a process from it,
//! and opening its URL. The scan itself lives in `xdev-ports`.

use tauri::{AppHandle, State};
use xdev_ports::PortScan;

use crate::commands::CmdError;
use crate::pty::Ptys;

/// Emitted when a terminal prints a URL not seen before.
#[allow(dead_code)] // emitted once the URL feed is wired
pub const ADVERTISED_EVENT: &str = "ports://advertised";

/// The payload of `ADVERTISED_EVENT`: the worktree whose terminal printed it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // built once the URL feed is wired
pub struct PortsAdvertised {
    pub worktree: String,
}

/// State for the port scan; filled in by the scan wiring.
#[derive(Default)]
pub struct Ports {
    /// The ports of the last scan, so `ports_open` only opens what a scan showed.
    #[allow(dead_code)] // read by `ports_open` once it is wired
    last: std::sync::Mutex<Vec<xdev_ports::WorkspacePort>>,
}

fn scan_failed() -> CmdError {
    CmdError {
        code: "scan_failed",
        detail: Some("not wired yet".into()),
    }
}

/// One scan. The window passes its worktrees so no registry is read here.
#[tauri::command(async)]
pub fn ports_scan(
    _ports: State<'_, Ports>,
    _ptys: State<'_, Ptys>,
    _worktrees: Vec<String>,
    _force: bool,
) -> Result<PortScan, CmdError> {
    Err(scan_failed())
}

/// Stops the process behind the port `id`, then returns a fresh scan.
#[tauri::command(async)]
pub fn ports_stop(
    _ports: State<'_, Ports>,
    _ptys: State<'_, Ptys>,
    _worktrees: Vec<String>,
    _id: String,
) -> Result<PortScan, CmdError> {
    Err(scan_failed())
}

/// Opens the URL of the port `id` from the last scan in the OS browser. The
/// webview never passes a URL.
#[tauri::command]
pub fn ports_open(_app: AppHandle, _ports: State<'_, Ports>, _id: String) -> Result<(), CmdError> {
    Err(scan_failed())
}
