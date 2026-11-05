//! `xdev agent-hook <event>`: what an agent CLI's hook runs. It appends one
//! line to `<local_dir>/hooks/<XDEV_PTY_ID>.jsonl` for the desktop to pick up.
//! It never fails the agent's turn: stdout stays empty, the exit code is
//! always 0 and a problem is at most one stderr line.
//!
//! The CLI's hook JSON arrives on stdin (claude, codex hooks) or as the last
//! argument (codex `notify`). Only a few fields are kept, as the line's
//! `detail` and `session`: never the prompt (`prompt`, notify's
//! `input-messages`).

use std::io::{IsTerminal, Read};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::ValueEnum;
use serde_json::Value;
use xdev_agent::{
    HOOKS_DIR, HookDetail, HookEvent, append_hook_detail, hooks_off, question_of, valid_pty_id,
};

/// The events a hook reports, as written on the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Event {
    Prompt,
    NeedsInput,
    Resume,
    TurnDone,
    TurnFailed,
    Interrupt,
    Attention,
}

impl From<Event> for HookEvent {
    fn from(event: Event) -> Self {
        match event {
            Event::Prompt => HookEvent::Prompt,
            Event::NeedsInput => HookEvent::NeedsInput,
            Event::Resume => HookEvent::Resume,
            Event::TurnDone => HookEvent::TurnDone,
            Event::TurnFailed => HookEvent::TurnFailed,
            Event::Interrupt => HookEvent::Interrupt,
            Event::Attention => HookEvent::Attention,
        }
    }
}

/// The subcommand's name, so `main` can tell a bad hook call from any other
/// bad command line.
pub const NAME: &str = "agent-hook";

/// The most stdin a hook reads, and how long it waits for it.
const STDIN_MAX: u64 = 64 * 1024;
const STDIN_WAIT: Duration = Duration::from_secs(1);

/// Writes the line; any error is printed to stderr and swallowed. `rest` is
/// whatever the CLI appended (codex `notify` passes its JSON last).
pub fn run(event: Event, rest: &[String]) {
    if let Err(reason) = write(event, rest) {
        eprintln!("xdev agent-hook: {reason}");
    }
}

fn write(event: Event, rest: &[String]) -> Result<(), String> {
    let local = xdev_core::local_dir().ok_or("no local data folder")?;
    // Switched off (`xdev agent hooks off`, or the app's setting): a silent
    // no-op, even for a pane launched while the hooks were on.
    if hooks_off(&local) {
        return Ok(());
    }
    let id = std::env::var("XDEV_PTY_ID").map_err(|_| "XDEV_PTY_ID is not set".to_owned())?;
    if !valid_pty_id(&id) {
        return Err("XDEV_PTY_ID is not a pane id".to_owned());
    }
    if event == Event::Attention {
        let detail = attention_message(rest).map(|message| HookDetail {
            message: Some(message),
            ..HookDetail::default()
        });
        return append(&local, &id, event, detail, None);
    }
    let notify = rest.last().and_then(|arg| json_object(arg.as_bytes()));
    let input = match &notify {
        Some(_) => None,
        None => read_stdin().and_then(|bytes| json_object(&bytes)),
    };
    let detail = match (&notify, &input) {
        (Some(payload), _) => {
            if stale_turn(&local, &id, payload) || reported_turn(&local, &id, payload) {
                return Ok(());
            }
            Some(notify_detail(payload))
        }
        (None, Some(input)) => {
            match event {
                Event::Prompt => remember_turn(&local, &id, input, "turn"),
                Event::TurnDone => remember_turn(&local, &id, input, "done"),
                _ => {}
            }
            Some(stdin_detail(event, input))
        }
        (None, None) => None,
    };
    let session = match (&notify, &input) {
        (Some(payload), _) => notify_session(payload),
        (None, Some(input)) => text(input, "session_id"),
        (None, None) => None,
    };
    append(&local, &id, event, detail, session.as_deref())
}

fn append(
    local: &Path,
    id: &str,
    event: Event,
    detail: Option<HookDetail>,
    session: Option<&str>,
) -> Result<(), String> {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    append_hook_detail(local, id, event.into(), at, detail, session)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// `attention --message <text>` (or `--message=<text>`): the text, taken as
/// is (never as hook JSON); the last one wins. Stdin is not read.
fn attention_message(rest: &[String]) -> Option<String> {
    let mut message = None;
    let mut args = rest.iter();
    while let Some(arg) = args.next() {
        if arg == "--message" {
            message = args.next().cloned();
        } else if let Some(text) = arg.strip_prefix("--message=") {
            message = Some(text.to_owned());
        }
    }
    message.filter(|m| !m.is_empty())
}

/// Up to [`STDIN_MAX`] bytes of stdin, when it is not a terminal and the CLI
/// closes it within [`STDIN_WAIT`]. Longer input is cut, so it no longer
/// parses and is dropped.
fn read_stdin() -> Option<Vec<u8>> {
    if std::io::stdin().is_terminal() {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    // Left blocked if the CLI never closes stdin; the process exits anyway.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = std::io::stdin()
            .lock()
            .take(STDIN_MAX)
            .read_to_end(&mut bytes);
        let _ = tx.send(read.map(|_| bytes));
    });
    rx.recv_timeout(STDIN_WAIT).ok()?.ok()
}

fn json_object(bytes: &[u8]) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_slice(bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn text(map: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)?.as_str().map(str::to_owned)
}

/// The whitelisted hook stdin fields. `last_assistant_message` stands in for
/// `message` on `turn-done` (claude and codex `Stop`). A `needs-input` keeps
/// the question it stopped on (`question_of`).
fn stdin_detail(event: Event, input: &serde_json::Map<String, Value>) -> HookDetail {
    let mut message = text(input, "message");
    if message.is_none() && event == Event::TurnDone {
        message = text(input, "last_assistant_message");
    }
    HookDetail {
        tool_name: text(input, "tool_name"),
        message,
        is_interrupt: input
            .get("is_interrupt")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error: text(input, "error"),
        tool_input: input
            .get("tool_input")
            .and_then(Value::as_object)
            .and_then(tool_input_preview),
        question: (event == Event::NeedsInput)
            .then(|| question_of(input))
            .flatten(),
    }
}

/// What the tool works on, as one short line: the first line of `command`,
/// else `file_path`, `path`, `pattern` or `url`. Never the whole input, so
/// file bodies and edits stay out of the hook file.
fn tool_input_preview(input: &serde_json::Map<String, Value>) -> Option<String> {
    let command = text(input, "command").and_then(|c| {
        c.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_owned)
    });
    command.or_else(|| {
        ["file_path", "path", "pattern", "url"]
            .iter()
            .filter_map(|key| text(input, key))
            .map(|t| t.trim().to_owned())
            .find(|t| !t.is_empty())
    })
}

/// Codex `notify`: only `last-assistant-message`, never `input-messages`.
fn notify_detail(payload: &serde_json::Map<String, Value>) -> HookDetail {
    HookDetail {
        message: text(payload, "last-assistant-message"),
        ..HookDetail::default()
    }
}

/// Codex `notify`: its session id, `session_id` or else `thread-id`.
/// [Unverified] that `thread-id` is the id `codex resume` takes; a wrong one
/// only makes the UI fall back to the newest session in the worktree.
fn notify_session(payload: &serde_json::Map<String, Value>) -> Option<String> {
    text(payload, "session_id").or_else(|| text(payload, "thread-id"))
}

/// Where the turn id of the pane's last codex prompt (`turn`) or `Stop`
/// (`done`) is kept. The desktop reads only `*.jsonl` there.
fn turn_file(local: &Path, id: &str, kind: &str) -> std::path::PathBuf {
    local.join(HOOKS_DIR).join(format!("{id}.{kind}"))
}

/// Keeps codex's `turn_id` from `UserPromptSubmit` or `Stop`, so a `notify`
/// for another turn (codex runs internal title turns), or for a turn `Stop`
/// already reported, can be told apart.
fn remember_turn(local: &Path, id: &str, input: &serde_json::Map<String, Value>, kind: &str) {
    let Some(turn) = text(input, "turn_id").filter(|t| t.len() <= 200) else {
        return;
    };
    let path = turn_file(local, id, kind);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, turn);
}

/// A `notify` payload whose `turn-id` is not the pane's last prompt's turn.
/// Without a known turn (codex without hooks) every payload counts.
fn stale_turn(local: &Path, id: &str, payload: &serde_json::Map<String, Value>) -> bool {
    let Ok(known) = std::fs::read_to_string(turn_file(local, id, "turn")) else {
        return false;
    };
    text(payload, "turn-id").is_some_and(|turn| turn != known)
}

/// A `notify` payload for the turn whose `Stop` hook already wrote
/// `turn-done`: notify is only the fallback for when the hooks do not run.
fn reported_turn(local: &Path, id: &str, payload: &serde_json::Map<String, Value>) -> bool {
    let Ok(done) = std::fs::read_to_string(turn_file(local, id, "done")) else {
        return false;
    };
    text(payload, "turn-id").is_some_and(|turn| turn == done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn preview_takes_first_command_line() {
        let m = map(serde_json::json!({ "command": "
  git status 
rm x", "path": "p" }));
        assert_eq!(tool_input_preview(&m).as_deref(), Some("git status"));
    }

    #[test]
    fn preview_order_file_path_path_pattern_url() {
        let m =
            map(serde_json::json!({ "url": "u", "pattern": "pt", "path": "pa", "file_path": "f" }));
        assert_eq!(tool_input_preview(&m).as_deref(), Some("f"));
        let m = map(serde_json::json!({ "url": "u", "pattern": "pt", "path": "pa" }));
        assert_eq!(tool_input_preview(&m).as_deref(), Some("pa"));
        let m = map(serde_json::json!({ "url": "u", "pattern": "pt" }));
        assert_eq!(tool_input_preview(&m).as_deref(), Some("pt"));
        let m = map(serde_json::json!({ "url": "u" }));
        assert_eq!(tool_input_preview(&m).as_deref(), Some("u"));
    }

    #[test]
    fn prompt_is_never_kept() {
        let m = map(serde_json::json!({
            "tool_name": "Bash",
            "prompt": "SECRET",
            "tool_input": { "content": "SECRET", "new_string": "SECRET" },
        }));
        let d = stdin_detail(Event::Resume, &m);
        assert_eq!(d.tool_input, None);
        assert!(!format!("{d:?}").contains("SECRET"));
    }

    #[test]
    fn only_needs_input_keeps_the_question() {
        let text = include_str!("../../xdev-agent/fixtures/hooks/claude-ask-user-question.json");
        let m: serde_json::Map<String, Value> = serde_json::from_str(text).unwrap();
        let q = stdin_detail(Event::NeedsInput, &m).question.unwrap();
        assert_eq!(q.options.len(), 3);
        assert_eq!(stdin_detail(Event::Resume, &m).question, None);
    }
}
