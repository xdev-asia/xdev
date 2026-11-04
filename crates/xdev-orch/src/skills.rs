//! The skill that teaches agents the protocol: where it is installed and how
//! far each agent can see it. The install logic arrives with the skills task;
//! these are the types.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The skill's folder name under every skills root.
pub const SKILL_NAME: &str = "xdev-orchestration";

/// One place the skill is written to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillTarget {
    pub agent: String,
    pub dir: PathBuf,
    /// False for the canonical copy; true for a link (or copy) of it.
    pub link: bool,
}

/// One agent CLI and whether it sees the skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SkillAgent {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub ready: bool,
    pub path: Option<String>,
}

/// What Settings shows on the skill card.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub installed: bool,
    pub edited: bool,
    pub canonical: String,
    pub agents: Vec<SkillAgent>,
    pub install_command: String,
}
