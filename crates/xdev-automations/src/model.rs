//! The stored shapes: an automation, its runs, and the wire strings of their enums.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const DEFAULT_GRACE_MINUTES: u32 = 720;
pub const PRECHECK_TIMEOUT_DEFAULT_S: u32 = 60;
pub const PRECHECK_TIMEOUT_MAX_S: u32 = 600;
pub const PRECHECK_OUTPUT_MAX_CHARS: usize = 4000;
pub const MAX_RUNS_PER_AUTOMATION: usize = 100;
pub const SNAPSHOT_MAX_LINES: usize = 2000;
pub const DEFAULT_TICK_MS: i64 = 60_000;
pub const AGENT_START_DEADLINE_MS: i64 = 120_000;
pub const OBSERVE_DEADLINE_MS: i64 = 6 * 3_600_000;

/// Where a run happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    Existing,
    NewPerRun,
}

/// Whether a new worktree runs the repo's setup script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum SetupDecision {
    Inherit,
    Run,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Dispatching,
    Dispatched,
    Completed,
    SkippedPrecheck,
    SkippedMissed,
    SkippedUnavailable,
    SkippedNeedsInteractiveAuth,
    DispatchFailed,
}

impl RunStatus {
    /// Final runs never change again; the others wait for a dispatch result or the watchdog.
    pub fn is_final(self) -> bool {
        !matches!(self, Self::Pending | Self::Dispatching | Self::Dispatched)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum RunTrigger {
    Scheduled,
    Manual,
}

/// Why a run did not complete. The UI translates by code; `english` is the stored fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FailureCode {
    NoDispatchHost,
    UnevaluableSchedule,
    MissedGraceWindow,
    TargetUnavailable,
    RepoUnavailable,
    WorktreeCreateFailed,
    AutomationChanged,
    NeedsApproval,
    AgentNeverStarted,
    AgentNoCompletion,
    AgentInterrupted,
    WatchTimedOut,
    PrecheckTimedOut,
    PrecheckFailed,
    PrecheckExit,
}

impl FailureCode {
    pub fn english(self, params: &BTreeMap<String, String>) -> String {
        let p = |k: &str| params.get(k).cloned().unwrap_or_default();
        match self {
            Self::NoDispatchHost => "xDev has no open window to start this run.".into(),
            Self::UnevaluableSchedule => {
                "The schedule could not be read, so this run was skipped.".into()
            }
            Self::MissedGraceWindow => {
                "xDev was not running when this run was due, and the grace window has passed."
                    .into()
            }
            Self::TargetUnavailable => "The workspace for this automation is not available.".into(),
            Self::RepoUnavailable => "The project for this automation is not available.".into(),
            Self::WorktreeCreateFailed => {
                format!("Could not create the workspace: {}", p("detail"))
            }
            Self::AutomationChanged => "The automation changed before this run started.".into(),
            Self::NeedsApproval => {
                "The agent needs your approval to start. Open xDev and approve it.".into()
            }
            Self::AgentNeverStarted => "The agent did not start working in time.".into(),
            Self::AgentNoCompletion => "The agent stopped before it finished.".into(),
            Self::AgentInterrupted => "xDev closed while this run was in progress.".into(),
            Self::WatchTimedOut => "The agent did not finish within 6 hours.".into(),
            Self::PrecheckTimedOut => format!("Precheck timed out after {}s.", p("seconds")),
            Self::PrecheckFailed => format!("Precheck failed: {}", p("error")),
            Self::PrecheckExit => format!("Precheck exited with code {}.", p("code")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Precheck {
    pub command: String,
    pub timeout_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrecheckResult {
    pub command: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: i64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub error: Option<String>,
    pub started_at: i64,
    pub completed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OutputSnapshot {
    pub content: String,
    pub captured_at: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub precheck: Option<Precheck>,
    /// An xdev-agent profile id (`claude`, `codex`, or a custom id).
    pub agent: String,
    pub extra_agent_args: Option<String>,
    /// An xdev-workspace repo id.
    pub repo_id: String,
    pub workspace_mode: WorkspaceMode,
    /// Worktree path (its id), `existing` only.
    pub worktree: Option<String>,
    /// `new_per_run` only; `None` is the repo default.
    pub base_branch: Option<String>,
    pub setup_decision: SetupDecision,
    pub reuse_session: bool,
    pub timezone: String,
    pub rrule: String,
    pub dtstart: i64,
    pub enabled: bool,
    pub next_run_at: i64,
    pub last_run_at: Option<i64>,
    pub missed_run_grace_minutes: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub title: String,
    pub run_number: u32,
    pub scheduled_for: i64,
    pub status: RunStatus,
    pub trigger: RunTrigger,
    pub worktree: Option<String>,
    pub worktree_name: Option<String>,
    pub tab_id: Option<String>,
    pub output_snapshot: Option<OutputSnapshot>,
    pub precheck_result: Option<PrecheckResult>,
    pub error: Option<String>,
    pub error_code: Option<FailureCode>,
    pub error_params: Option<BTreeMap<String, String>>,
    pub started_at: Option<i64>,
    pub dispatched_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub created_at: i64,
    #[serde(default = "one")]
    pub occurrence_count: u32,
    pub last_occurrence_at: Option<i64>,
}

/// Create and full update: the editor always sends every field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub name: String,
    pub prompt: String,
    pub precheck: Option<Precheck>,
    pub agent: String,
    pub extra_agent_args: Option<String>,
    pub repo_id: String,
    pub workspace_mode: WorkspaceMode,
    pub worktree: Option<String>,
    pub base_branch: Option<String>,
    pub setup_decision: SetupDecision,
    pub reuse_session: bool,
    pub timezone: String,
    pub rrule: String,
    pub dtstart: i64,
    pub enabled: bool,
    pub missed_run_grace_minutes: u32,
}
