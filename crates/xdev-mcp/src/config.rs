//! What the app and the MCP server process share on disk: which app tools are
//! switched on, and the log of recent tool calls. Only the formats live here;
//! the callers pick the paths and do the I/O, so this stays pure.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// In the app's config folder: the switches, written by the app, read by the server.
pub const SETTINGS_FILE: &str = "mcp-tools.json";
/// In the app's local folder: the log, written by every server process, read by the app.
pub const ACTIVITY_FILE: &str = "mcp-activity.json";

/// The log keeps this many calls, newest last.
pub const ACTIVITY_MAX: usize = 200;

/// Per-tool switches the person set. A tool missing from the map keeps its
/// default (see [`crate::app_tools::AppTool::default_on`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolSettings {
    #[serde(default)]
    pub tools: BTreeMap<String, bool>,
}

impl ToolSettings {
    /// A missing or broken file means all defaults: a server must still start.
    pub fn parse(text: &str) -> ToolSettings {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_owned())
    }

    /// Whether `tool` is on: the stored switch, else its default.
    pub fn enabled(&self, tool: &str) -> bool {
        match self.tools.get(tool) {
            Some(on) => *on,
            None => crate::app_tools::find(tool).is_some_and(|t| t.default_on),
        }
    }
}

/// One tool call. Arguments are never kept, for any tool: a `send_to_tab`
/// text may hold anything the person typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub at_ms: u64,
    pub tool: String,
    pub ok: bool,
    pub duration_ms: u64,
}

/// The last [`ACTIVITY_MAX`] calls, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityLog {
    #[serde(default)]
    pub entries: Vec<ActivityEntry>,
}

impl ActivityLog {
    pub fn parse(text: &str) -> ActivityLog {
        let mut log: ActivityLog = serde_json::from_str(text).unwrap_or_default();
        log.trim();
        log
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
    }

    pub fn push(&mut self, entry: ActivityEntry) {
        self.entries.push(entry);
        self.trim();
    }

    fn trim(&mut self) {
        let extra = self.entries.len().saturating_sub(ACTIVITY_MAX);
        self.entries.drain(..extra);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: u64) -> ActivityEntry {
        ActivityEntry {
            at_ms: n,
            tool: "list_tabs".into(),
            ok: true,
            duration_ms: 1,
        }
    }

    #[test]
    fn defaults_apply_until_a_switch_is_stored() {
        let mut s = ToolSettings::default();
        assert!(s.enabled("list_tabs"));
        assert!(!s.enabled("send_to_tab"));
        assert!(!s.enabled("no_such_tool"));
        s.tools.insert("send_to_tab".into(), true);
        s.tools.insert("list_tabs".into(), false);
        let back = ToolSettings::parse(&s.to_json());
        assert!(back.enabled("send_to_tab"));
        assert!(!back.enabled("list_tabs"));
    }

    #[test]
    fn a_broken_settings_file_is_the_defaults() {
        assert_eq!(ToolSettings::parse("{not json"), ToolSettings::default());
        assert_eq!(ToolSettings::parse(""), ToolSettings::default());
    }

    #[test]
    fn the_log_keeps_the_newest_200() {
        let mut log = ActivityLog::default();
        for n in 0..250 {
            log.push(entry(n));
        }
        assert_eq!(log.entries.len(), ACTIVITY_MAX);
        assert_eq!(log.entries[0].at_ms, 50);
        assert_eq!(log.entries.last().map(|e| e.at_ms), Some(249));
        // A file written with more is cut on load.
        let big = ActivityLog {
            entries: (0..300).map(entry).collect(),
        };
        assert_eq!(
            ActivityLog::parse(&big.to_json()).entries.len(),
            ACTIVITY_MAX
        );
    }
}
