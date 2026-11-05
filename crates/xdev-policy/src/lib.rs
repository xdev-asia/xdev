//! What xDev itself may do on the user's behalf. The check runs in the app,
//! not in a prompt, so an agent cannot talk its way past it.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub mod links;
pub use links::{Grants, LinkBook, ReadKind, check_read};

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
    /// Start an agent CLI in a terminal. `permissions` is the CLI's own
    /// approval mode; `"skip"` means it will not ask before acting.
    LaunchAgent {
        profile: String,
        program: String,
        args: Vec<String>,
        permissions: String,
    },
    /// Replace a remote branch with the local one.
    ForcePush {
        worktree: PathBuf,
        remote: String,
        branch: String,
    },
    /// Throw away uncommitted changes of `paths` (relative to `worktree`).
    Discard {
        worktree: PathBuf,
        paths: Vec<String>,
    },
    /// A worktree verb of the app CLI (`op` is `create` or `set`) on
    /// `worktree`, from a caller whose `scope` is `own`, `family`, `other`
    /// or `external`. The scope is a label, not an identity.
    CliWorktree {
        op: String,
        worktree: PathBuf,
        scope: String,
    },
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rule {
    #[default]
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Policy {
    pub agent_tools: Vec<String>,
    pub commands: Vec<String>,
    pub merge: Rule,
    pub delete: Rule,
    /// `agent_fingerprint`s a person has approved once.
    pub approved_agents: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            agent_tools: ["Read", "Edit", "Write", "Grep", "Glob"]
                .map(String::from)
                .to_vec(),
            commands: Vec::new(),
            merge: Rule::Ask,
            delete: Rule::Ask,
            approved_agents: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("invalid policy: {0}")]
    Parse(String),
}

impl PolicyError {
    pub fn code(&self) -> &'static str {
        match self {
            PolicyError::Io(_) => "io",
            PolicyError::Parse(_) => "policy_invalid",
        }
    }
}

impl Policy {
    pub fn load(data_dir: &Path) -> Result<Policy, PolicyError> {
        let bytes = match fs::read(data_dir.join("policy.json")) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Policy::default()),
            Err(e) => return Err(e.into()),
        };
        serde_json::from_slice(&bytes).map_err(|e| PolicyError::Parse(e.to_string()))
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), PolicyError> {
        let mut text =
            serde_json::to_string_pretty(self).map_err(|e| PolicyError::Parse(e.to_string()))?;
        text.push('\n');
        fs::create_dir_all(data_dir)?;
        fs::write(data_dir.join("policy.json"), text)?;
        Ok(())
    }
}

impl Gate for Policy {
    fn check(&self, action: &Action) -> Verdict {
        match action {
            Action::SpawnAgent { tools, .. } => {
                let extra: Vec<_> = tools
                    .iter()
                    .filter(|tool| !self.agent_tools.contains(tool))
                    .map(String::as_str)
                    .collect();
                if extra.is_empty() {
                    Verdict::Allow
                } else {
                    Verdict::Ask {
                        reason: format!("agent tools require approval: {}", extra.join(", ")),
                    }
                }
            }
            Action::RunCommand { program, .. } => {
                let stem = Path::new(program).file_stem().and_then(|s| s.to_str());
                if stem.is_some_and(|stem| {
                    self.commands.iter().any(|command| {
                        if cfg!(windows) {
                            stem.eq_ignore_ascii_case(command)
                        } else {
                            stem == command
                        }
                    })
                }) {
                    Verdict::Allow
                } else {
                    Verdict::Ask {
                        reason: format!("command requires approval: {program}"),
                    }
                }
            }
            Action::Merge { .. } => rule_verdict(self.merge, "merge"),
            Action::Delete { .. } => rule_verdict(self.delete, "delete"),
            // No rule can relax this: a person confirms every force push.
            Action::ForcePush { .. } => Verdict::Ask {
                reason: "force push always asks".to_owned(),
            },
            // Loses work that git cannot bring back: a person confirms every time.
            Action::Discard { .. } => Verdict::Ask {
                reason: "discarding changes always asks".to_owned(),
            },
            // The caller's own worktree, and a create or set in its family
            // (the endpoint sends `family` only for writes downwards), pass;
            // anything else is the person's call.
            Action::CliWorktree { op, scope, .. } => {
                let family = scope == "family" && matches!(op.as_str(), "create" | "set" | "send");
                if scope == "own" || family {
                    Verdict::Allow
                } else {
                    Verdict::Ask {
                        reason: format!("cli worktree {op} from scope {scope} asks"),
                    }
                }
            }
            Action::LaunchAgent {
                profile,
                program,
                args,
                permissions,
            } => {
                if permissions == "skip" {
                    Verdict::Ask {
                        reason: "skip-approval mode always asks".to_owned(),
                    }
                } else if self.approved_agents.contains(&agent_fingerprint(
                    program,
                    args,
                    permissions,
                )) {
                    Verdict::Allow
                } else {
                    Verdict::Ask {
                        reason: format!("first launch of agent profile {profile}"),
                    }
                }
            }
        }
    }
}

/// Identifies one agent launch line, so an approval covers exactly it.
pub fn agent_fingerprint(program: &str, args: &[String], permissions: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in [program]
        .into_iter()
        .chain(args.iter().map(String::as_str))
        .chain([permissions])
    {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    hasher.finalize().to_hex().to_string()
}

fn rule_verdict(rule: Rule, action: &str) -> Verdict {
    match rule {
        Rule::Ask => Verdict::Ask {
            reason: format!("{action} requires approval"),
        },
        Rule::Deny => Verdict::Deny {
            reason: format!("{action} denied by policy"),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub at: u64,
    pub action: Action,
    pub verdict: Verdict,
}

pub struct Audited<G> {
    inner: G,
    log: PathBuf,
}

impl<G> Audited<G> {
    pub fn new(inner: G, data_dir: &Path) -> Self {
        Audited {
            inner,
            log: data_dir.join("audit.jsonl"),
        }
    }

    fn append(&self, action: &Action, verdict: &Verdict) -> io::Result<()> {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs();
        let entry = AuditEntry {
            at,
            action: action.clone(),
            verdict: verdict.clone(),
        };
        let mut line = serde_json::to_vec(&entry).map_err(io::Error::other)?;
        line.push(b'\n');
        if let Some(parent) = self.log.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)?;
        file.write_all(&line)?;
        file.sync_data()
    }
}

impl<G: Gate> Audited<G> {
    /// Like `check`, but a one-time confirmation turns `Ask` into `Allow`
    /// and the log records what ran. Nothing is saved as a standing approval.
    pub fn check_confirmed(&self, action: &Action, confirmed: bool) -> Verdict {
        match self.inner.check(action) {
            Verdict::Ask { .. } if confirmed => self.logged(action, Verdict::Allow),
            verdict => self.logged(action, verdict),
        }
    }

    /// Records that a person refused, or never answered, an action that
    /// asked; nothing is saved as a standing refusal.
    pub fn refused(&self, action: &Action, reason: &str) -> Verdict {
        self.logged(
            action,
            Verdict::Deny {
                reason: reason.to_owned(),
            },
        )
    }

    fn logged(&self, action: &Action, verdict: Verdict) -> Verdict {
        if self.append(action, &verdict).is_err() {
            return Verdict::Deny {
                reason: "audit log not writable".to_owned(),
            };
        }
        verdict
    }
}

impl<G: Gate> Gate for Audited<G> {
    fn check(&self, action: &Action) -> Verdict {
        self.logged(action, self.inner.check(action))
    }
}

pub fn read_audit(data_dir: &Path) -> Result<Vec<AuditEntry>, PolicyError> {
    let text = fs::read_to_string(data_dir.join("audit.jsonl"))?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|e| PolicyError::Parse(e.to_string())))
        .collect()
}

#[cfg(test)]
mod tests;
