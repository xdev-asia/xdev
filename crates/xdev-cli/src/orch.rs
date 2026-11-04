//! `xdev orchestration <verb>` (alias `orch`): coordinate agents in other
//! xDev tabs. Each verb is one request, `orchestration.<verb>`, to the
//! running app; the app owns the data. Only parsing and request mapping
//! live here, and the text each answer prints.

use std::fs;
use std::io::Read;

use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

use crate::app::{AppError, io_error};

/// The most a spec or a message body may hold.
pub const BODY_MAX: usize = 64 * 1024;
/// How long `check --wait` waits when no timeout is given.
pub const CHECK_WAIT_MS: u64 = 120_000;
/// How long a coordinator's `ask --wait` waits when no timeout is given.
pub const ASK_WAIT_MS: u64 = 600_000;
/// The longest `ask --wait`.
pub const ASK_WAIT_MAX_MS: u64 = 1_800_000;
/// How long `worker-start` waits for the worker to be ready.
pub const START_WAIT_MS: u64 = 60_000;

#[derive(Args)]
pub struct OrchArgs {
    #[command(flatten)]
    pub common: Common,
    #[command(subcommand)]
    pub verb: OrchVerb,
}

/// Flags every verb takes.
#[derive(Args, Default)]
pub struct Common {
    /// The run to act on; default is the caller tab's current run.
    #[arg(long, global = true)]
    pub run: Option<String>,
    /// Act for this tab (default: the terminal the CLI runs in).
    #[arg(long = "as", global = true, value_name = "TAB")]
    pub as_tab: Option<String>,
    /// Repeat of an earlier request: the first answer comes back, nothing runs twice.
    #[arg(long, global = true, value_name = "ID")]
    pub retry_request: Option<String>,
    /// Print the raw answer as JSON.
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Subcommand)]
pub enum OrchVerb {
    /// Start a run: a namespace for tasks, workers and mail. The creating
    /// tab becomes its coordinator.
    RunCreate {
        #[arg(long)]
        objective: Option<String>,
    },
    /// Make `id` this tab's current run.
    RunUse { id: String },
    /// The current run of this tab.
    RunCurrent,
    /// Every run.
    RunList,
    /// A run with its tasks, workers and open gates.
    RunShow { id: Option<String> },
    /// Add a task to the run's DAG.
    TaskCreate {
        #[arg(long)]
        title: Option<String>,
        /// The task's text. `--spec-file -` reads stdin.
        #[arg(long, conflicts_with = "spec_file")]
        spec: Option<String>,
        #[arg(long, value_name = "PATH|-")]
        spec_file: Option<String>,
        /// A task this one waits for; repeat for more.
        #[arg(long = "dep", value_name = "TASK")]
        deps: Vec<String>,
        #[arg(long)]
        parent: Option<String>,
    },
    /// Tasks of the run.
    TaskList {
        #[arg(long)]
        status: Option<String>,
        /// Only tasks that can start now.
        #[arg(long)]
        ready: bool,
        /// Cut each spec to a line.
        #[arg(long)]
        brief: bool,
    },
    /// Change a task's status (completed, failed, blocked, ready) or result.
    TaskUpdate {
        id: String,
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        result: Option<String>,
    },
    /// Start a worker agent in another tab. Exit 0 when it is ready, 1 when
    /// the start failed or is unknown.
    WorkerStart(WorkerStartArgs),
    /// One worker: state, tab, worktree.
    WorkerShow { handle: String },
    /// Workers of the run.
    WorkerList,
    /// The terminal text of a worker's tab.
    WorkerRead {
        handle: String,
        #[arg(long)]
        max_chars: Option<u32>,
    },
    /// Close a worker's tab. Refused while it is kept open.
    WorkerStop { handle: String },
    /// Give a worker up without closing its tab.
    WorkerAbandon { handle: String },
    /// Let a finished worker's tab go.
    WorkerRelease { handle: String },
    /// Keep a worker's tab open past the auto-close (`--off` undoes it).
    WorkerKeepOpen {
        handle: String,
        #[arg(long)]
        off: bool,
    },
    /// Send a message to `run:<id>`, `dispatch:<id>`, or a group (`@all`,
    /// `@idle`, `@worktree:<id>`, `@<agent>`).
    Send(SendArgs),
    /// Read the oldest unread messages (at most 50) and mark them handled.
    Check(CheckArgs),
    /// A list of messages with short previews.
    Inbox {
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        full: bool,
    },
    /// Answer a message; it goes to the original sender, in the same thread.
    Reply {
        #[arg(long)]
        id: String,
        /// The text; `-` reads stdin.
        #[arg(long)]
        body: String,
    },
    /// Ask a question. A worker's ask returns at once (end your turn); a
    /// coordinator's waits with `--wait`.
    Ask(AskArgs),
    /// Open a decision gate on a task.
    GateCreate {
        #[arg(long)]
        task: String,
        #[arg(long)]
        question: String,
        #[arg(long = "option")]
        options: Vec<String>,
    },
    /// Resolve a gate; the answer goes to the asker.
    GateResolve {
        id: String,
        #[arg(long)]
        resolution: String,
    },
    /// Gates of the run.
    GateList {
        #[arg(long)]
        pending: bool,
    },
    /// Forget tasks, messages or everything of the run (`--all`: of every run).
    Reset {
        #[arg(long, conflicts_with_all = ["tasks", "messages"])]
        all: bool,
        #[arg(long)]
        tasks: bool,
        #[arg(long)]
        messages: bool,
    },
    /// What an earlier `--retry-request` answered.
    RequestShow { id: String },
}

#[derive(Args)]
pub struct WorkerStartArgs {
    /// An existing task of the run.
    #[arg(long)]
    pub task: Option<String>,
    /// A new task's text.
    #[arg(long, conflicts_with = "spec_file")]
    pub spec: Option<String>,
    #[arg(long, value_name = "PATH|-")]
    pub spec_file: Option<String>,
    /// The agent profile to start (claude, codex, gemini, or a custom one).
    #[arg(long)]
    pub agent: Option<String>,
    /// An existing tab to use as the worker.
    #[arg(long, value_name = "TAB")]
    pub terminal: Option<String>,
    /// Do not close the tab when the worker finishes.
    #[arg(long)]
    pub keep_open: bool,
    /// `current`, a worktree name or id, `new-child` or `new-top-level`.
    #[arg(long)]
    pub worktree: Option<String>,
    /// The tab's title; default `worker-<task id>`.
    #[arg(long)]
    pub name: Option<String>,
    /// `inherit` runs the repo's setup first; `skip` does not.
    #[arg(long, value_parser = ["inherit", "skip", "run"])]
    pub setup: Option<String>,
    /// The dispatch this start retries.
    #[arg(long)]
    pub retry_of: Option<String>,
    #[arg(long)]
    pub timeout_ms: Option<u64>,
    /// Not supported yet; answers `unsupported`.
    #[arg(long)]
    pub model: Option<String>,
    /// Not supported yet; answers `unsupported`.
    #[arg(long)]
    pub effort: Option<String>,
}

#[derive(Args)]
pub struct SendArgs {
    #[arg(long)]
    pub to: String,
    #[arg(long = "type", default_value = "status", value_parser = TYPES)]
    pub kind: String,
    #[arg(long)]
    pub subject: Option<String>,
    /// The text; `-` reads stdin.
    #[arg(long)]
    pub body: Option<String>,
    #[arg(long, value_parser = ["normal", "high", "urgent"])]
    pub priority: Option<String>,
    /// JSON attached to the message.
    #[arg(long)]
    pub payload: Option<String>,
    /// For `worker_done`: how the task ended.
    #[arg(long, value_parser = ["succeeded", "failed"])]
    pub outcome: Option<String>,
    #[arg(long)]
    pub thread: Option<String>,
}

const TYPES: [&str; 9] = [
    "status",
    "dispatch",
    "worker_done",
    "merge_ready",
    "escalation",
    "handoff",
    "decision_gate",
    "question",
    "heartbeat",
];

#[derive(Args)]
pub struct CheckArgs {
    /// Block until mail arrives.
    #[arg(long)]
    pub wait: bool,
    /// How long `--wait` waits; default 120000.
    #[arg(long)]
    pub timeout_ms: Option<u64>,
    /// Look, but do not mark anything handled.
    #[arg(long)]
    pub peek: bool,
    /// Include messages already handled.
    #[arg(long)]
    pub all: bool,
    /// Only these types, comma separated.
    #[arg(long, value_delimiter = ',')]
    pub types: Vec<String>,
}

#[derive(Args)]
pub struct AskArgs {
    #[arg(long)]
    pub question: Option<String>,
    #[arg(long = "option")]
    pub options: Vec<String>,
    /// Block until the question is answered (a coordinator only).
    #[arg(long)]
    pub wait: bool,
    /// How long `--wait` waits; default 600000, at most 1800000.
    #[arg(long)]
    pub timeout_ms: Option<u64>,
    /// Pick up the answer of an earlier ask by its gate id.
    #[arg(long, value_name = "GATE")]
    pub resume: Option<String>,
}

/// The text of `value`: `-` is stdin, anything else itself.
fn text_arg(value: &str, stdin: &mut dyn Read) -> Result<String, AppError> {
    let text = if value == "-" {
        let mut s = String::new();
        stdin.read_to_string(&mut s).map_err(io_error)?;
        s
    } else {
        value.to_owned()
    };
    sized(text)
}

fn sized(text: String) -> Result<String, AppError> {
    if text.len() > BODY_MAX {
        return Err(AppError {
            code: "too_large".to_owned(),
            message: format!("the text is over {} KiB", BODY_MAX / 1024),
        });
    }
    Ok(text)
}

/// A spec from `--spec` or `--spec-file` (`-` is stdin; a path is read here).
fn spec_of(
    spec: &Option<String>,
    file: &Option<String>,
    stdin: &mut dyn Read,
) -> Result<Option<String>, AppError> {
    match (spec, file) {
        (Some(s), _) => sized(s.clone()).map(Some),
        (None, Some(f)) if f == "-" => text_arg("-", stdin).map(Some),
        (None, Some(path)) => {
            let bytes = fs::read(path).map_err(|e| AppError {
                code: "bad_request".to_owned(),
                message: format!("cannot read {path}: {e}"),
            })?;
            let text = String::from_utf8(bytes).map_err(|_| AppError {
                code: "bad_request".to_owned(),
                message: format!("{path} is not text"),
            })?;
            sized(text).map(Some)
        }
        (None, None) => Ok(None),
    }
}

/// `--worktree` as the app reads it.
fn worktree_pick(value: &str) -> Value {
    match value {
        "current" => json!("current"),
        "new-child" => json!("new_child"),
        "new-top-level" => json!("new_top_level"),
        other => json!({ "selector": other }),
    }
}

fn bad_request(message: impl Into<String>) -> AppError {
    AppError {
        code: "bad_request".to_owned(),
        message: message.into(),
    }
}

/// What one verb sends: the method, the params, and whether to print JSON.
pub fn request(
    args: &OrchArgs,
    stdin: &mut dyn Read,
) -> Result<(&'static str, Value, bool), AppError> {
    let (method, mut params): (&'static str, Value) = match &args.verb {
        OrchVerb::RunCreate { objective } => (
            "orchestration.run-create",
            json!({ "objective": objective }),
        ),
        OrchVerb::RunUse { id } => ("orchestration.run-use", json!({ "id": id })),
        OrchVerb::RunCurrent => ("orchestration.run-current", json!({})),
        OrchVerb::RunList => ("orchestration.run-list", json!({})),
        OrchVerb::RunShow { id } => ("orchestration.run-show", json!({ "id": id })),
        OrchVerb::TaskCreate {
            title,
            spec,
            spec_file,
            deps,
            parent,
        } => {
            let spec = spec_of(spec, spec_file, stdin)?;
            (
                "orchestration.task-create",
                json!({ "title": title, "spec": spec, "deps": deps, "parent": parent }),
            )
        }
        OrchVerb::TaskList {
            status,
            ready,
            brief,
        } => (
            "orchestration.task-list",
            json!({ "status": status, "ready": ready, "brief": brief }),
        ),
        OrchVerb::TaskUpdate { id, status, result } => (
            "orchestration.task-update",
            json!({ "id": id, "status": status, "result": result }),
        ),
        OrchVerb::WorkerStart(w) => {
            let spec = spec_of(&w.spec, &w.spec_file, stdin)?;
            (
                "orchestration.worker-start",
                json!({
                    "task": w.task,
                    "spec": spec,
                    "agent": w.agent,
                    "terminal": w.terminal,
                    "keepOpen": w.keep_open,
                    "worktree": w.worktree.as_deref().map(worktree_pick),
                    "name": w.name,
                    "setup": w.setup,
                    "retryOf": w.retry_of,
                    "timeoutMs": w.timeout_ms.unwrap_or(START_WAIT_MS),
                    "model": w.model,
                    "effort": w.effort,
                }),
            )
        }
        OrchVerb::WorkerShow { handle } => {
            ("orchestration.worker-show", json!({ "handle": handle }))
        }
        OrchVerb::WorkerList => ("orchestration.worker-list", json!({})),
        OrchVerb::WorkerRead { handle, max_chars } => (
            "orchestration.worker-read",
            json!({ "handle": handle, "maxChars": max_chars }),
        ),
        OrchVerb::WorkerStop { handle } => {
            ("orchestration.worker-stop", json!({ "handle": handle }))
        }
        OrchVerb::WorkerAbandon { handle } => {
            ("orchestration.worker-abandon", json!({ "handle": handle }))
        }
        OrchVerb::WorkerRelease { handle } => {
            ("orchestration.worker-release", json!({ "handle": handle }))
        }
        OrchVerb::WorkerKeepOpen { handle, off } => (
            "orchestration.worker-keep-open",
            json!({ "handle": handle, "keep": !off }),
        ),
        OrchVerb::Send(s) => {
            let body = match &s.body {
                Some(b) => Some(text_arg(b, stdin)?),
                None => None,
            };
            let payload = match &s.payload {
                Some(p) => Some(
                    serde_json::from_str::<Value>(p)
                        .map_err(|e| bad_request(format!("--payload is not JSON: {e}")))?,
                ),
                None => None,
            };
            (
                "orchestration.send",
                json!({
                    "to": s.to,
                    "type": s.kind,
                    "subject": s.subject,
                    "body": body,
                    "priority": s.priority,
                    "payload": payload,
                    "outcome": s.outcome,
                    "thread": s.thread,
                }),
            )
        }
        OrchVerb::Check(c) => (
            "orchestration.check",
            json!({
                "wait": c.wait,
                "timeoutMs": c.wait.then(|| c.timeout_ms.unwrap_or(CHECK_WAIT_MS)),
                "peek": c.peek,
                "all": c.all,
                "types": c.types,
            }),
        ),
        OrchVerb::Inbox { limit, full } => (
            "orchestration.inbox",
            json!({ "limit": limit, "full": full }),
        ),
        OrchVerb::Reply { id, body } => (
            "orchestration.reply",
            json!({ "id": id, "body": text_arg(body, stdin)? }),
        ),
        OrchVerb::Ask(a) => (
            "orchestration.ask",
            json!({
                "question": a.question,
                "options": a.options,
                "wait": a.wait,
                "timeoutMs": a.wait.then(|| a.timeout_ms.unwrap_or(ASK_WAIT_MS).min(ASK_WAIT_MAX_MS)),
                "resume": a.resume,
            }),
        ),
        OrchVerb::GateCreate {
            task,
            question,
            options,
        } => (
            "orchestration.gate-create",
            json!({ "task": task, "question": question, "options": options }),
        ),
        OrchVerb::GateResolve { id, resolution } => (
            "orchestration.gate-resolve",
            json!({ "id": id, "resolution": resolution }),
        ),
        OrchVerb::GateList { pending } => {
            ("orchestration.gate-list", json!({ "pending": pending }))
        }
        OrchVerb::Reset {
            all,
            tasks,
            messages,
        } => {
            if !(*all || *tasks || *messages) {
                return Err(bad_request("reset needs --all, --tasks or --messages"));
            }
            (
                "orchestration.reset",
                json!({ "all": all, "tasks": tasks, "messages": messages }),
            )
        }
        OrchVerb::RequestShow { id } => ("orchestration.request-show", json!({ "id": id })),
    };
    if let Value::Object(map) = &mut params {
        put(map, "run", &args.common.run);
        put(map, "as", &args.common.as_tab);
        put(map, "retryRequest", &args.common.retry_request);
    }
    Ok((method, params, args.common.json))
}

fn put(map: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(v) = value {
        map.insert(key.to_owned(), json!(v));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Probe {
        #[command(flatten)]
        orch: OrchArgs,
    }

    fn map(line: &str) -> (&'static str, Value, bool) {
        map_with(line, b"")
    }

    fn map_with(line: &str, stdin: &[u8]) -> (&'static str, Value, bool) {
        let words = std::iter::once("orch").chain(line.split_whitespace());
        let probe = Probe::try_parse_from(words).unwrap_or_else(|e| panic!("{line}: {e}"));
        request(&probe.orch, &mut &stdin[..]).unwrap()
    }

    #[test]
    fn every_verb_maps_to_its_method_and_params() {
        let cases: [(&str, &str, Value); 26] = [
            (
                "run-create --objective ship",
                "orchestration.run-create",
                json!({"objective": "ship"}),
            ),
            (
                "run-use run_1",
                "orchestration.run-use",
                json!({"id": "run_1"}),
            ),
            ("run-current", "orchestration.run-current", json!({})),
            ("run-list", "orchestration.run-list", json!({})),
            ("run-show", "orchestration.run-show", json!({"id": null})),
            (
                "task-create --title t --spec s --dep a --dep b --parent p",
                "orchestration.task-create",
                json!({"title": "t", "spec": "s", "deps": ["a", "b"], "parent": "p"}),
            ),
            (
                "task-list --ready --brief",
                "orchestration.task-list",
                json!({"status": null, "ready": true, "brief": true}),
            ),
            (
                "task-update task_1 --status completed --result ok",
                "orchestration.task-update",
                json!({"id": "task_1", "status": "completed", "result": "ok"}),
            ),
            (
                "worker-start --task task_1 --agent claude --keep-open --worktree new-child --name n --setup skip --retry-of d --timeout-ms 5000",
                "orchestration.worker-start",
                json!({"task": "task_1", "spec": null, "agent": "claude", "terminal": null, "keepOpen": true,
                       "worktree": "new_child", "name": "n", "setup": "skip", "retryOf": "d",
                       "timeoutMs": 5000, "model": null, "effort": null}),
            ),
            (
                "worker-show d1",
                "orchestration.worker-show",
                json!({"handle": "d1"}),
            ),
            ("worker-list", "orchestration.worker-list", json!({})),
            (
                "worker-read d1 --max-chars 100",
                "orchestration.worker-read",
                json!({"handle": "d1", "maxChars": 100}),
            ),
            (
                "worker-stop d1",
                "orchestration.worker-stop",
                json!({"handle": "d1"}),
            ),
            (
                "worker-abandon d1",
                "orchestration.worker-abandon",
                json!({"handle": "d1"}),
            ),
            (
                "worker-release d1",
                "orchestration.worker-release",
                json!({"handle": "d1"}),
            ),
            (
                "worker-keep-open d1 --off",
                "orchestration.worker-keep-open",
                json!({"handle": "d1", "keep": false}),
            ),
            (
                "send --to run:r --type question --subject s --body b --priority high --payload {\"a\":1} --thread m1",
                "orchestration.send",
                json!({"to": "run:r", "type": "question", "subject": "s", "body": "b", "priority": "high",
                       "payload": {"a": 1}, "outcome": null, "thread": "m1"}),
            ),
            (
                "check --wait --peek --types status,question",
                "orchestration.check",
                json!({"wait": true, "timeoutMs": 120000, "peek": true, "all": false, "types": ["status", "question"]}),
            ),
            (
                "inbox --limit 5 --full",
                "orchestration.inbox",
                json!({"limit": 5, "full": true}),
            ),
            (
                "reply --id msg_1 --body thanks",
                "orchestration.reply",
                json!({"id": "msg_1", "body": "thanks"}),
            ),
            (
                "ask --question why --option a --option b --wait",
                "orchestration.ask",
                json!({"question": "why", "options": ["a", "b"], "wait": true, "timeoutMs": 600000, "resume": null}),
            ),
            (
                "gate-create --task t --question q --option x",
                "orchestration.gate-create",
                json!({"task": "t", "question": "q", "options": ["x"]}),
            ),
            (
                "gate-resolve gate_1 --resolution yes",
                "orchestration.gate-resolve",
                json!({"id": "gate_1", "resolution": "yes"}),
            ),
            (
                "gate-list --pending",
                "orchestration.gate-list",
                json!({"pending": true}),
            ),
            (
                "reset --tasks",
                "orchestration.reset",
                json!({"all": false, "tasks": true, "messages": false}),
            ),
            (
                "request-show req_1",
                "orchestration.request-show",
                json!({"id": "req_1"}),
            ),
        ];
        for (line, method, params) in cases {
            let (m, p, json) = map(line);
            assert_eq!(m, method, "{line}");
            assert_eq!(p, params, "{line}");
            assert!(!json);
        }
    }

    #[test]
    fn the_common_flags_reach_every_params_object() {
        let (_, p, json) = map("check --run run_9 --as tab-1 --retry-request req_7 --json");
        assert!(json);
        assert_eq!(p["run"], "run_9");
        assert_eq!(p["as"], "tab-1");
        assert_eq!(p["retryRequest"], "req_7");
        // Flags may come before the verb too.
        let (_, p, _) = map("--run run_2 task-list");
        assert_eq!(p["run"], "run_2");
    }

    #[test]
    fn worker_start_terminal_is_the_worker_tab_not_the_caller() {
        let (_, p, _) = map("worker-start --spec s --terminal tab-9 --as tab-1");
        assert_eq!(p["terminal"], "tab-9");
        assert_eq!(p["as"], "tab-1");
    }

    #[test]
    fn a_worktree_selector_and_the_words_map_to_the_picks() {
        assert_eq!(worktree_pick("current"), json!("current"));
        assert_eq!(worktree_pick("new-top-level"), json!("new_top_level"));
        assert_eq!(
            worktree_pick("settings-polish"),
            json!({"selector": "settings-polish"})
        );
    }

    #[test]
    fn a_dash_reads_the_spec_and_the_body_from_stdin() {
        let (_, p, _) = map_with("worker-start --spec-file - --agent codex", b"do it\n");
        assert_eq!(p["spec"], "do it\n");
        let (_, p, _) = map_with("send --to run:r --body -", b"hello");
        assert_eq!(p["body"], "hello");
    }

    #[test]
    fn a_spec_file_is_read_in_the_cli_and_capped() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("spec.md");
        fs::write(&ok, "the spec").unwrap();
        let (_, p, _) = map(&format!("task-create --spec-file {}", ok.display()));
        assert_eq!(p["spec"], "the spec");
        let big = dir.path().join("big.md");
        fs::write(&big, "x".repeat(BODY_MAX + 1)).unwrap();
        let probe =
            Probe::try_parse_from(["orch", "task-create", "--spec-file", big.to_str().unwrap()])
                .unwrap();
        let err = request(&probe.orch, &mut &b""[..]).err().unwrap();
        assert_eq!(err.code, "too_large");
        let probe =
            Probe::try_parse_from(["orch", "task-create", "--spec-file", "/no/such/file"]).unwrap();
        assert_eq!(
            request(&probe.orch, &mut &b""[..]).err().unwrap().code,
            "bad_request"
        );
    }

    #[test]
    fn a_bad_payload_and_a_bare_reset_are_bad_requests() {
        let probe =
            Probe::try_parse_from(["orch", "send", "--to", "run:r", "--payload", "{oops"]).unwrap();
        assert_eq!(
            request(&probe.orch, &mut &b""[..]).err().unwrap().code,
            "bad_request"
        );
        let probe = Probe::try_parse_from(["orch", "reset"]).unwrap();
        assert_eq!(
            request(&probe.orch, &mut &b""[..]).err().unwrap().code,
            "bad_request"
        );
    }

    #[test]
    fn an_ask_wait_is_capped_at_thirty_minutes() {
        let (_, p, _) = map("ask --question q --wait --timeout-ms 99999999");
        assert_eq!(p["timeoutMs"], ASK_WAIT_MAX_MS);
        let (_, p, _) = map("ask --question q");
        assert_eq!(p["timeoutMs"], Value::Null);
    }
}
