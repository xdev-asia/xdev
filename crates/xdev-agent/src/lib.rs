//! A coding agent's task: a goal worked on in its own git worktree, with the
//! evidence kept and nothing merged until a person approves. A squad is a
//! team of agents, one per seat, working one task together.

mod catalog;
mod codex_home;
mod detect;
mod flags;
mod flow;
mod hooks;
mod id;
mod launch;
mod process;
pub mod profiles;
mod prompts;
mod route;
mod runner;
mod shells;
mod squad;
mod squad_run;
mod store;
mod trust;
mod version;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use xdev_git::GitError;
use xdev_policy::Verdict;

pub use catalog::{
    AUTO_ORDER, AgentSpec, PromptMode, TrustKind, has_permission_args, modes, permission_env,
    pick_agent, prompt_args, spec,
};
pub use codex_home::{
    CODEX_HOME_DIR, CODEX_HOOKS_SINCE, CODEX_INTERRUPT_SINCE, codex_hooks_json, hook_command,
    prepare_codex_home, private_codex_home, trust_hash,
};
pub use detect::{find_builtin, find_builtin_in, find_program, path_override, set_path_override};
pub use flags::{efforts, flags};
pub use flow::RunOptions;
pub use hooks::{
    DETAIL_MAX, HOOKS_DIR, HOOKS_OFF, HookDetail, HookEvent, HookLine, LINE_MAX, REPEAT_MS,
    SESSION_MAX, append_hook, append_hook_detail, hook_args, hook_file, hooks_off, set_hooks_off,
    valid_pty_id, valid_session_id,
};
pub use launch::{AccountSource, Context, Launch, LaunchError, resolve};
pub use profiles::{
    Approvals, Cli, CustomShell, DefaultAgent, EnvVar, Permissions, Profile, ProfileError,
    Profiles, builtin, valid_id,
};
pub use route::{RouteRule, Routing};
pub use runner::{
    Cancel, ClaudeRunner, CodexRunner, ContextUse, RunOutcome, RunRequest, Runner,
    parse_claude_json, parse_codex_jsonl,
};
pub use shells::{
    ShellEntry, ShellKind, default_shell_id, list_shells, parse_wsl_list, wsl_distros,
};
pub use squad::{
    Escalation, Event, Role, Seat, SeatState, SeatStatus, Squad, SquadRun, SquadStore, Step,
    Target, Wait,
};
pub use squad_run::{QuotaCheck, RunnerFor, SquadDeps};
pub use store::TaskStore;
pub use trust::{TrustError, TrustTarget, trust_folder};
pub use version::{CliVersion, cli_version};

/// Tools an agent gets when the caller names none: file work only.
pub const DEFAULT_TOOLS: [&str; 5] = ["Read", "Edit", "Write", "Grep", "Glob"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Task {
    pub id: String,
    pub goal: String,
    /// The repo's top folder.
    pub repo: PathBuf,
    /// The commit the task branch started from.
    pub base: String,
    pub branch: String,
    pub worktree: PathBuf,
    pub state: TaskState,
    pub runs: Vec<RunRecord>,
    pub evidence: Option<Evidence>,
    pub approval: Option<Approval>,
    /// Unix seconds.
    pub created: u64,
}

impl Task {
    /// The session the last run that reported one left behind.
    pub fn last_session(&self) -> Option<&str> {
        self.runs.iter().rev().find_map(|r| r.session_id.as_deref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Ready,
    Running,
    Paused,
    Review,
    Failed,
    Merged,
    Discarded,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Ready => "ready",
            TaskState::Running => "running",
            TaskState::Paused => "paused",
            TaskState::Review => "review",
            TaskState::Failed => "failed",
            TaskState::Merged => "merged",
            TaskState::Discarded => "discarded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct RunRecord {
    pub started: u64,
    pub ended: Option<u64>,
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub is_error: bool,
    /// The end of the agent's final message.
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Evidence {
    pub base: String,
    pub head: String,
    pub files: Vec<FileChange>,
    pub test: Option<TestResult>,
}

/// `None` counts are a binary file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct FileChange {
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct TestResult {
    pub command: Vec<String>,
    /// `None` when the command was killed or could not start.
    pub exit: Option<i32>,
    pub output_tail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Approval {
    pub at: u64,
    pub merge_commit: String,
}

/// The UI and CLI translate `code()`, never the message.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("not a git work tree")]
    NoRepo,
    #[error("the repo has no commits")]
    NoCommits,
    #[error("the goal is empty")]
    EmptyGoal,
    /// The gate did not allow the step; nothing was done.
    #[error("{}", verdict_text(.0))]
    Gated(Verdict),
    #[error("the repo has uncommitted changes")]
    DirtyRepo,
    #[error("the merge has conflicts and was aborted")]
    MergeConflict,
    #[error("no task with this id")]
    NotFound,
    #[error("not allowed while the task is {0}")]
    BadState(&'static str),
    #[error("the repo is not on a branch")]
    Detached,
    #[error("no earlier run left a session to resume")]
    NoSession,
    #[error("the task's worktree is gone")]
    NoWorktree,
    #[error("agent failed: {0}")]
    Runner(String),
    /// The agent was killed; with a session id the task can be resumed.
    #[error("agent timed out")]
    Timeout { session_id: Option<String> },
    /// The agent was killed on request; with a session id it can go on.
    #[error("agent stopped")]
    Stopped { session_id: Option<String> },
    #[error("the seat has no account")]
    SeatVacant,
    #[error("no account with this name")]
    UnknownAccount,
    #[error("the squad is busy with a run")]
    Busy,
    #[error("not a seat; one of lead, implement, tests, review")]
    BadRole,
    #[error("the name is empty")]
    EmptyName,
    #[error("the squad has no unfinished run")]
    NoRun,
    #[error("nothing is waiting for this")]
    NotWaiting,
    #[error("the text is empty")]
    EmptyText,
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AgentError {
    pub fn code(&self) -> &'static str {
        match self {
            AgentError::NoRepo => "no_repo",
            AgentError::NoCommits => "no_commits",
            AgentError::EmptyGoal => "empty_goal",
            AgentError::Gated(Verdict::Deny { .. }) => "denied",
            AgentError::Gated(_) => "needs_approval",
            AgentError::DirtyRepo => "dirty_repo",
            AgentError::MergeConflict => "merge_conflict",
            AgentError::NotFound => "not_found",
            AgentError::BadState(_) => "bad_state",
            AgentError::Detached => "detached",
            AgentError::NoSession => "no_session",
            AgentError::NoWorktree => "no_worktree",
            AgentError::Runner(_) => "runner",
            AgentError::Timeout { .. } => "timeout",
            AgentError::Stopped { .. } => "stopped",
            AgentError::SeatVacant => "seat_vacant",
            AgentError::UnknownAccount => "unknown_account",
            AgentError::Busy => "busy",
            AgentError::BadRole => "bad_role",
            AgentError::EmptyName => "empty_name",
            AgentError::NoRun => "no_run",
            AgentError::NotWaiting => "not_waiting",
            AgentError::EmptyText => "empty_text",
            AgentError::Git(GitError::NoRepo) => "no_repo",
            AgentError::Git(GitError::Io(_)) | AgentError::Io(_) => "io",
            AgentError::Git(GitError::NoGit) => "no_git",
            AgentError::Git(GitError::Identity) => "git_identity",
            AgentError::Git(_) => "git",
        }
    }
}

fn verdict_text(verdict: &Verdict) -> String {
    match verdict {
        Verdict::Allow => "allowed".to_owned(),
        Verdict::Ask { reason } => format!("needs approval: {reason}"),
        Verdict::Deny { reason } => format!("denied: {reason}"),
    }
}

/// The last `max` bytes of `text`, cut on a char boundary.
pub(crate) fn tail(text: &str, max: usize) -> String {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_char_boundaries() {
        assert_eq!(tail("abc", 10), "abc");
        assert_eq!(tail("abcdef", 3), "def");
        // `é` is two bytes; a cut through it moves forward.
        assert_eq!(tail("aé", 1), "");
        assert_eq!(tail("aéb", 2), "b");
    }

    #[test]
    fn gated_codes_follow_the_verdict() {
        let deny = AgentError::Gated(Verdict::Deny { reason: "x".into() });
        let ask = AgentError::Gated(Verdict::Ask { reason: "y".into() });
        assert_eq!(deny.code(), "denied");
        assert_eq!(ask.code(), "needs_approval");
        assert_eq!(ask.to_string(), "needs approval: y");
    }
}
