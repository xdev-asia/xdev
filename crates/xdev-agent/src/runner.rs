use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use xdev_ai::claude_command;

use crate::process::capture;
use crate::{AgentError, tail};

/// Enough of a failing agent's stderr to tell why, not a whole log.
const STDERR_TAIL: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    pub worktree: PathBuf,
    pub prompt: String,
    /// The session to continue instead of starting a new one.
    pub resume: Option<String>,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    /// The agent ran to the end but reported failure.
    pub is_error: bool,
    pub result: String,
}

/// The only thing orchestration knows about an agent, so another runner,
/// or a fake in tests, changes no orchestration code.
pub trait Runner {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError>;
}

/// Claude Code in print mode. `account_dir` is a `CLAUDE_CONFIG_DIR`; without
/// it the person's own Claude Code config is used.
#[derive(Debug, Clone)]
pub struct ClaudeRunner {
    pub account_dir: Option<PathBuf>,
    pub timeout: Duration,
}

impl Runner for ClaudeRunner {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
        let mut cmd = claude_command().map_err(|e| AgentError::Runner(e.code().to_owned()))?;
        // Windows cannot pass a line break to a batch file such as npm's
        // `claude.cmd`; the spawn would fail outright.
        let prompt = if is_batch(Path::new(cmd.get_program())) {
            one_line(&req.prompt)
        } else {
            req.prompt.clone()
        };
        cmd.current_dir(&req.worktree).arg("-p").arg(prompt).args([
            "--output-format",
            "json",
            "--permission-mode",
            "acceptEdits",
        ]);
        if let Some(id) = &req.resume {
            cmd.args(["--resume", id]);
        }
        // Last, because the option takes every value up to the next flag.
        if !req.tools.is_empty() {
            cmd.arg("--allowedTools").args(&req.tools);
        }
        if let Some(dir) = &self.account_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }

        let out = capture(cmd, self.timeout)?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let parsed = parse_claude_json(&stdout);
        if out.timed_out {
            // Print mode writes its JSON only at the end, so a resumed
            // session is usually the only id known.
            let session_id = parsed
                .ok()
                .and_then(|p| p.session_id)
                .or_else(|| req.resume.clone());
            return Err(AgentError::Timeout { session_id });
        }
        // The exit code alone is not trusted: an agent that failed still
        // prints its JSON, with `is_error` set.
        parsed.map_err(|_| {
            let stderr = String::from_utf8_lossy(&out.stderr);
            AgentError::Runner(format!(
                "exit {:?}: {}",
                out.status,
                tail(stderr.trim(), STDERR_TAIL)
            ))
        })
    }
}

fn is_batch(program: &Path) -> bool {
    program
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

fn one_line(text: &str) -> String {
    text.split(['\r', '\n'])
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The result object `claude -p --output-format json` prints. Missing fields
/// are tolerated; output with no JSON object is an error. Some versions print
/// an array of messages, whose `result` entry is used.
pub fn parse_claude_json(out: &str) -> Result<RunOutcome, AgentError> {
    let value = serde_json::from_str::<Value>(out.trim())
        .ok()
        .or_else(|| {
            // Anything a wrapper printed before the object is skipped.
            out.lines()
                .rev()
                .map(str::trim)
                .filter(|l| l.starts_with('{'))
                .find_map(|l| serde_json::from_str(l).ok())
        })
        .ok_or_else(|| AgentError::Runner("no JSON from the agent".to_owned()))?;
    let object = match value {
        Value::Object(_) => value,
        Value::Array(items) => items
            .into_iter()
            .rev()
            .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
            .ok_or_else(|| AgentError::Runner("no result in the agent's JSON".to_owned()))?,
        _ => return Err(AgentError::Runner("no JSON from the agent".to_owned())),
    };
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(RunOutcome {
        session_id: text("session_id").filter(|s| !s.is_empty()),
        cost_usd: object.get("total_cost_usd").and_then(Value::as_f64),
        is_error: object
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        result: text("result").unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_files_get_a_one_line_prompt() {
        assert!(is_batch(Path::new("npm/claude.CMD")));
        assert!(is_batch(Path::new("claude.bat")));
        assert!(!is_batch(Path::new("claude.exe")));
        assert!(!is_batch(Path::new("claude")));
        assert_eq!(one_line("Fix it\r\n\r\n  then test\n"), "Fix it then test");
    }

    #[test]
    fn full_object() {
        let out = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":12,
            "result":"Done.","session_id":"abc-123","total_cost_usd":0.0421,"usage":{}}"#;
        assert_eq!(
            parse_claude_json(out).unwrap(),
            RunOutcome {
                session_id: Some("abc-123".into()),
                cost_usd: Some(0.0421),
                is_error: false,
                result: "Done.".into(),
            }
        );
    }

    #[test]
    fn missing_fields_are_defaults() {
        assert_eq!(
            parse_claude_json("{}\n").unwrap(),
            RunOutcome {
                session_id: None,
                cost_usd: None,
                is_error: false,
                result: String::new(),
            }
        );
    }

    #[test]
    fn error_result_is_still_an_outcome() {
        let out = r#"{"is_error":true,"result":"Credit balance is too low","session_id":"s"}"#;
        let got = parse_claude_json(out).unwrap();
        assert!(got.is_error);
        assert_eq!(got.result, "Credit balance is too low");
    }

    #[test]
    fn noise_before_the_object_is_skipped() {
        let out = "warning: something\r\n{\"session_id\":\"s1\",\"result\":\"ok\"}\r\n";
        let got = parse_claude_json(out).unwrap();
        assert_eq!(got.session_id.as_deref(), Some("s1"));
        assert_eq!(got.result, "ok");
    }

    #[test]
    fn array_of_messages_uses_the_result() {
        let out = r#"[{"type":"system","session_id":"s0"},
            {"type":"result","session_id":"s2","total_cost_usd":1.5,"result":"r"}]"#;
        let got = parse_claude_json(out).unwrap();
        assert_eq!(got.session_id.as_deref(), Some("s2"));
        assert_eq!(got.cost_usd, Some(1.5));
    }

    #[test]
    fn wrong_types_are_ignored() {
        let out = r#"{"session_id":7,"total_cost_usd":"x","is_error":"yes","result":null}"#;
        let got = parse_claude_json(out).unwrap();
        assert_eq!(got.session_id, None);
        assert_eq!(got.cost_usd, None);
        assert!(!got.is_error);
    }

    #[test]
    fn no_json_is_an_error() {
        for out in ["", "Error: not logged in", "42", "[]"] {
            let err = parse_claude_json(out).unwrap_err();
            assert_eq!(err.code(), "runner", "{out:?}");
        }
    }
}
