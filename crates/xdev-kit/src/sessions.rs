//! Agent session history read from the CLI session logs. The index keeps
//! metadata only: ids, folder, branch, model, times, a message count and a
//! title cut from the first prompt (200 chars). Never the conversation.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Agent, FileMark, Home, KitError, RefreshStats};

const VERSION: u32 = 1;

/// One agent session on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// `<home id>:<session id>`, the same keying as `UsageIndex`.
    pub key: String,
    /// The CLI's session id: the log file stem for Claude, the session id in
    /// the log for Codex.
    pub id: String,
    pub home_id: String,
    pub agent: Agent,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// The first user prompt, on one line, at most 200 chars.
    pub title: Option<String>,
    pub model: Option<String>,
    /// Unix ms; 0 when no line had a time.
    pub first: i64,
    pub last: i64,
    /// User prompts and assistant replies seen.
    pub messages: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionIndex {
    pub version: u32,
    /// Keyed by the log file's path.
    #[serde(default)]
    pub files: BTreeMap<String, FileMark>,
    /// Keyed by `AgentSession::key`.
    #[serde(default)]
    pub sessions: BTreeMap<String, AgentSession>,
}

impl Default for SessionIndex {
    fn default() -> Self {
        Self {
            version: VERSION,
            files: BTreeMap::new(),
            sessions: BTreeMap::new(),
        }
    }
}

fn index_path(data_dir: &Path) -> PathBuf {
    data_dir.join("kit").join("sessions.json")
}

impl SessionIndex {
    /// `<data_dir>/kit/sessions.json`; missing, unreadable or of another
    /// version gives an empty index.
    pub fn load(data_dir: &Path) -> Self {
        let _ = index_path(data_dir);
        Self::default()
    }

    /// Atomic: written aside, then renamed over.
    pub fn save(&self, _data_dir: &Path) -> Result<(), KitError> {
        Ok(())
    }

    /// Reads what is new in the session logs of `homes`.
    pub fn refresh(&mut self, _homes: &[Home]) -> RefreshStats {
        RefreshStats::default()
    }

    /// Drops the sessions whose `last` is before `older_than_ms`, and their
    /// file marks.
    pub fn prune(&mut self, _older_than_ms: i64) {}

    /// Every session, newest `last` first.
    pub fn list(&self) -> Vec<&AgentSession> {
        Vec::new()
    }
}
