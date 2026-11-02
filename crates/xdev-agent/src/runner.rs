use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use xdev_ai::{claude_command, codex_command, codex_context, codex_home};

use crate::process::capture;
use crate::{AgentError, tail};

/// Enough of a failing agent's stderr to tell why, not a whole log.
const STDERR_TAIL: usize = 2000;
/// Claude Code's window when the result names none.
const DEFAULT_CLAUDE_WINDOW: u64 = 200_000;
/// Tools that change files; a run without them gets a read-only sandbox.
const WRITE_TOOLS: [&str; 2] = ["Edit", "Write"];

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
    /// How full the session's context window was after the run, when the
    /// agent reports it.
    pub context: Option<ContextUse>,
}

/// Tokens, not characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextUse {
    pub used: u64,
    pub window: u64,
}

/// The only thing orchestration knows about an agent, so another runner,
/// or a fake in tests, changes no orchestration code.
pub trait Runner {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError>;

    /// The provider the gate rules on.
    fn provider(&self) -> &str {
        "claude"
    }
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

/// Codex CLI's `exec` mode. `account_dir` is a `CODEX_HOME`; without it the
/// person's own Codex config is used.
#[derive(Debug, Clone)]
pub struct CodexRunner {
    pub account_dir: Option<PathBuf>,
    pub timeout: Duration,
}

impl Runner for CodexRunner {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
        let mut cmd = codex_command().map_err(|e| AgentError::Runner(e.code().to_owned()))?;
        let prompt = if is_batch(Path::new(cmd.get_program())) {
            one_line(&req.prompt)
        } else {
            req.prompt.clone()
        };
        let sandbox = if req.tools.iter().any(|t| WRITE_TOOLS.contains(&t.as_str())) {
            "workspace-write"
        } else {
            "read-only"
        };
        cmd.current_dir(&req.worktree).arg("exec");
        match &req.resume {
            // `exec resume` takes neither `-s` nor `-C` (0.165), so the
            // sandbox goes in as a config override and the folder as the
            // working directory.
            Some(id) => {
                cmd.args(["resume", "--json", "--skip-git-repo-check", "-c"])
                    .arg(format!("sandbox_mode={sandbox}"))
                    .arg("--")
                    .arg(id);
            }
            None => {
                cmd.args(["--json", "--skip-git-repo-check", "-s", sandbox, "-C"])
                    .arg(&req.worktree)
                    .arg("--");
            }
        }
        // After `--`, so a prompt that starts with `-` stays a prompt.
        cmd.arg(prompt);
        if let Some(dir) = &self.account_dir {
            cmd.env("CODEX_HOME", dir);
        }

        let out = capture(cmd, self.timeout)?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let parsed = parse_codex_jsonl(&stdout);
        if out.timed_out {
            // The stream names the session first, so a killed run can
            // usually be resumed.
            let session_id = parsed
                .ok()
                .and_then(|p| p.session_id)
                .or_else(|| req.resume.clone());
            return Err(AgentError::Timeout { session_id });
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stderr = tail(stderr.trim(), STDERR_TAIL);
        let mut outcome =
            parsed.map_err(|_| AgentError::Runner(format!("exit {:?}: {stderr}", out.status)))?;
        if out.status != Some(0) {
            outcome.is_error = true;
        }
        if outcome.is_error && outcome.result.is_empty() {
            outcome.result = stderr;
        }
        if let (Some(id), Some(home)) =
            (&outcome.session_id, codex_home(self.account_dir.as_deref()))
        {
            outcome.context =
                codex_context(&home, id).map(|(used, window)| ContextUse { used, window });
        }
        Ok(outcome)
    }

    fn provider(&self) -> &str {
        "codex"
    }
}

/// The event stream `codex exec --json` prints, one object a line. Lines
/// that are not JSON are skipped; a stream with no event at all is an
/// error. `context` is left empty: the stream does not report the window.
pub fn parse_codex_jsonl(out: &str) -> Result<RunOutcome, AgentError> {
    let mut outcome = RunOutcome {
        session_id: None,
        cost_usd: None,
        is_error: false,
        result: String::new(),
        context: None,
    };
    let mut events = 0;
    let mut completed = false;
    let mut failure = None;
    for line in out.lines().map(str::trim).filter(|l| l.starts_with('{')) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        events += 1;
        match kind {
            "thread.started" => {
                if let Some(id) = event.get("thread_id").and_then(Value::as_str) {
                    outcome.session_id = Some(id.to_owned()).filter(|s| !s.is_empty());
                }
            }
            "item.completed" => {
                let item = &event["item"];
                if item["type"] == "agent_message"
                    && let Some(text) = item["text"].as_str()
                {
                    outcome.result = text.to_owned();
                }
            }
            "turn.completed" => completed = true,
            "turn.failed" => {
                failure = Some(event["error"]["message"].as_str().unwrap_or("").to_owned());
            }
            "error" => {
                failure = Some(event["message"].as_str().unwrap_or("").to_owned());
            }
            _ => {}
        }
    }
    if events == 0 {
        return Err(AgentError::Runner("no JSON from the agent".to_owned()));
    }
    if let Some(message) = failure {
        outcome.is_error = true;
        if outcome.result.is_empty() {
            outcome.result = message;
        }
    } else if !completed {
        outcome.is_error = true;
    }
    Ok(outcome)
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
        context: claude_context(&object),
    })
}

/// What the last model call sent. `usage` sums every call of the run, so
/// its last `iterations` entry is used when there is one.
fn claude_context(object: &Value) -> Option<ContextUse> {
    let usage = object.get("usage")?;
    let turn = usage
        .get("iterations")
        .and_then(Value::as_array)
        .and_then(|turns| turns.last())
        .unwrap_or(usage);
    let parts: Vec<u64> = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|key| turn.get(*key).and_then(Value::as_u64))
    .collect();
    if parts.is_empty() {
        return None;
    }
    // A run can call a small helper model too; the window that matters is
    // the main model's, the one that read the most.
    let window = object
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|models| {
            models
                .values()
                .filter_map(|m| {
                    let read = [
                        "inputTokens",
                        "cacheReadInputTokens",
                        "cacheCreationInputTokens",
                    ]
                    .iter()
                    .filter_map(|key| m.get(*key).and_then(Value::as_u64))
                    .sum::<u64>();
                    Some((read, m.get("contextWindow")?.as_u64()?))
                })
                .max_by_key(|(read, _)| *read)
        })
        .map_or(DEFAULT_CLAUDE_WINDOW, |(_, window)| window);
    Some(ContextUse {
        used: parts.iter().sum(),
        window,
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
                context: None,
            }
        );
    }

    /// A real `claude -p "Reply ok" --output-format json` result, with ids
    /// and free text replaced.
    #[test]
    fn recorded_claude_result_has_context() {
        let got = parse_claude_json(include_str!("../tests/fixtures/claude-result.json")).unwrap();
        assert_eq!(got.result, "ok");
        assert_eq!(
            got.session_id.as_deref(),
            Some("00000000-0000-4000-8000-0000000c1a0d")
        );
        assert_eq!(
            got.context,
            Some(ContextUse {
                used: 2 + 32_647,
                window: 1_000_000,
            })
        );
    }

    #[test]
    fn claude_context_uses_last_call_and_main_model() {
        let out = r#"{"result":"r","usage":{"input_tokens":900,"cache_read_input_tokens":900,
            "iterations":[{"input_tokens":5,"cache_read_input_tokens":100},
                          {"input_tokens":7,"cache_read_input_tokens":300,"cache_creation_input_tokens":20}]},
            "modelUsage":{"small":{"inputTokens":50,"contextWindow":100000},
                          "main":{"inputTokens":12,"cacheReadInputTokens":400,"contextWindow":400000}}}"#;
        assert_eq!(
            parse_claude_json(out).unwrap().context,
            Some(ContextUse {
                used: 327,
                window: 400_000,
            })
        );
        let out = r#"{"usage":{"input_tokens":10,"cache_creation_input_tokens":5}}"#;
        assert_eq!(
            parse_claude_json(out).unwrap().context,
            Some(ContextUse {
                used: 15,
                window: DEFAULT_CLAUDE_WINDOW,
            })
        );
    }

    /// A real `codex exec --json` stream (0.165), with the thread id
    /// replaced.
    #[test]
    fn recorded_codex_stream() {
        let got = parse_codex_jsonl(include_str!("../tests/fixtures/codex-exec.jsonl")).unwrap();
        assert_eq!(
            got,
            RunOutcome {
                session_id: Some("0199a000-0000-7000-8000-00000000c0de".into()),
                cost_usd: None,
                is_error: false,
                result: "ok".into(),
                context: None,
            }
        );
    }

    #[test]
    fn codex_failed_turn_is_an_error_outcome() {
        let out = "Reading additional input from stdin...\n\
            {\"type\":\"thread.started\",\"thread_id\":\"t1\"}\n\
            {\"type\":\"turn.started\"}\n\
            {\"type\":\"error\",\"message\":\"stream disconnected\"}\n\
            {\"type\":\"turn.failed\",\"error\":{\"message\":\"usage limit reached\"}}\n";
        let got = parse_codex_jsonl(out).unwrap();
        assert_eq!(got.session_id.as_deref(), Some("t1"));
        assert!(got.is_error);
        assert_eq!(got.result, "usage limit reached");

        // Cut off before the turn ended.
        let got =
            parse_codex_jsonl("{\"type\":\"thread.started\",\"thread_id\":\"t2\"}\n").unwrap();
        assert!(got.is_error);
        assert_eq!(got.session_id.as_deref(), Some("t2"));
    }

    #[test]
    fn codex_without_events_is_an_error() {
        for out in ["", "Error: not logged in", "{}", "[1]"] {
            let err = parse_codex_jsonl(out).unwrap_err();
            assert_eq!(err.code(), "runner", "{out:?}");
        }
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
                context: None,
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
