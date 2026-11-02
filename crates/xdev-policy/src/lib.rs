//! What xDev itself may do on the user's behalf. The check runs in the app,
//! not in a prompt, so an agent cannot talk its way past it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// An action xDev is about to take. Agents act inside their own worktree;
/// these are the steps around that run which touch the user's repo or
/// spend their quota.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Start a coding agent in `worktree` with these tools allowed.
    SpawnAgent {
        provider: String,
        account: Option<String>,
        worktree: PathBuf,
        tools: Vec<String>,
    },
    /// Run a command, such as the project's tests, in `cwd`.
    RunCommand {
        program: String,
        args: Vec<String>,
        cwd: PathBuf,
    },
    /// Merge a task branch into the user's branch.
    Merge { from: String, into: String },
    /// Remove a file or folder outside xDev's own data folder.
    Delete { path: PathBuf },
}

/// `Ask` stops until a person approves; nothing proceeds on silence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Ask { reason: String },
    Deny { reason: String },
}

/// Anything that can rule on an action. Callers depend on this trait so
/// tests and later policy sources can stand in for the file-based policy.
pub trait Gate {
    fn check(&self, action: &Action) -> Verdict;
}
