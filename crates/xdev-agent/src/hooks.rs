//! Status hooks: how an agent CLI tells xDev that a prompt was sent, that it
//! waits for the person, or that its turn ended.
//!
//! Checked on 2026-11-03, Windows 11, each CLI run once with the flags from
//! `hook_args` and the command pointed at a script that logs argv and stdin:
//!
//! - `claude` 2.1.317 (`claude -p "say ok" --settings '<json>'`): the
//!   `{"hooks":{"<Event>":[{"hooks":[{"type":"command","command":"\"<prog>\" <args>"}]}]}}`
//!   shape is accepted; a quoted program path with `/` separators runs.
//!   `UserPromptSubmit` and `Stop` fired once each, with the hook JSON on
//!   stdin and `XDEV_PTY_ID` inherited from the CLI's environment.
//!   Plan 4b spike (same day, 2.1.317): every event in `CLAUDE_HOOKS` fires.
//!   The command runs under bash on Windows too (`$BASH_VERSION` set), so
//!   the program is quoted as a POSIX double-quoted word.
//! - `codex` 0.165.0 (`codex exec -c 'notify=["<prog>",...,"turn-done"]'`):
//!   the program ran once at the end of the turn with
//!   `{"type":"agent-turn-complete",...}` appended as the last argv; stdin
//!   empty; `XDEV_PTY_ID` inherited.
//! - Terminal titles per state (OSC 0/2): not checked (needs the app).
//! - Notification click: not run on screen. The locked
//!   `tauri-plugin-notification` 2.8.0 reports a click on desktop through
//!   `Notification::on_action` (`action_id == "tap"`, Windows only while the
//!   toast is on screen), so the desktop emits `status://notification-click`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::profiles::Cli;
use crate::version::CliVersion;

mod question;
pub use question::{
    HookQuestion, LABEL_MAX, NOTE_MAX, OPTIONS_MAX, QUESTION_MAX, QuestionKind, QuestionOption,
    question_of,
};

/// The folder under `local_dir` that holds one `<pty_id>.jsonl` per pane.
pub const HOOKS_DIR: &str = "hooks";

/// The file in [`HOOKS_DIR`] that turns every `xdev agent-hook` call into a
/// no-op, so switching hooks off also quiets panes launched with them.
pub const HOOKS_OFF: &str = ".off";

/// Whether the [`HOOKS_OFF`] marker is there.
pub fn hooks_off(local_dir: &Path) -> bool {
    local_dir.join(HOOKS_DIR).join(HOOKS_OFF).is_file()
}

/// Creates (`off`) or removes the [`HOOKS_OFF`] marker; either is a no-op when
/// already so. The marker is an empty file xDev owns, so removing it is safe.
pub fn set_hooks_off(local_dir: &Path, off: bool) -> io::Result<()> {
    let dir = local_dir.join(HOOKS_DIR);
    let marker = dir.join(HOOKS_OFF);
    if off {
        fs::create_dir_all(&dir)?;
        fs::write(marker, b"")
    } else {
        match fs::remove_file(marker) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// What an agent's hook reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum HookEvent {
    /// A prompt was sent.
    Prompt,
    /// The agent waits for the person (permission, question, elicitation).
    NeedsInput,
    /// Work went on after a needs-input: the tool ran or the answer arrived.
    Resume,
    /// The turn ended.
    TurnDone,
    /// The turn ended on an error (claude `StopFailure`, which comes instead of `Stop`).
    TurnFailed,
    /// The person stopped the turn (codex `Interrupt`); settles quietly.
    Interrupt,
    /// `xdev agent-hook attention`: something outside the agent asks for a look.
    Attention,
}

impl HookEvent {
    /// The event an `xdev agent-hook <name>` writes.
    pub fn from_name(name: &str) -> Option<HookEvent> {
        Some(match name {
            "prompt" => HookEvent::Prompt,
            "needs-input" => HookEvent::NeedsInput,
            "resume" => HookEvent::Resume,
            "turn-done" => HookEvent::TurnDone,
            "turn-failed" => HookEvent::TurnFailed,
            "interrupt" => HookEvent::Interrupt,
            "attention" => HookEvent::Attention,
            _ => return None,
        })
    }
}

/// Each event of `names` once, in order.
pub(crate) fn events_of<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<HookEvent> {
    let mut out = Vec::new();
    for event in names.into_iter().filter_map(HookEvent::from_name) {
        if !out.contains(&event) {
            out.push(event);
        }
    }
    out
}

/// The few hook stdin fields xDev keeps. Never the prompt text. Each string
/// is at most [`DETAIL_MAX`] chars.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct HookDetail {
    pub tool_name: Option<String>,
    pub message: Option<String>,
    pub is_interrupt: bool,
    pub error: Option<String>,
    /// A short preview of what the tool works on (a command's first line, or
    /// a path, pattern or url). Never the whole tool input.
    pub tool_input: Option<String>,
    /// The question a `needs-input` stopped on, when the hook said it. Left
    /// out when absent, so lines without it read and write as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub question: Option<HookQuestion>,
}

/// The longest string a [`HookDetail`] field keeps, in chars.
pub const DETAIL_MAX: usize = 180;

/// One line of a hook file. `detail` and `session` are left out when empty,
/// so v1 lines written before they existed still read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookLine {
    pub v: u32,
    pub event: HookEvent,
    /// Unix time in milliseconds.
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<HookDetail>,
    /// The agent's own session id from the hook stdin (`session_id`) or codex
    /// `notify` (`thread-id`); only when [`valid_session_id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// The longest agent session id a hook line keeps, in chars.
pub const SESSION_MAX: usize = 128;

/// An agent session id a hook line may carry: 1..=[`SESSION_MAX`] chars of
/// `[A-Za-z0-9._-]`. It goes back to the CLI as a resume argument, so
/// nothing else is kept.
pub fn valid_session_id(id: &str) -> bool {
    (1..=SESSION_MAX).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A pane id as the UI makes it: a lowercase UUID, so it is safe as a file name.
pub fn valid_pty_id(id: &str) -> bool {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut parts = id.split('-');
    let ok = GROUPS.iter().all(|&len| {
        parts.next().is_some_and(|part| {
            part.len() == len
                && part
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    });
    ok && parts.next().is_none()
}

/// The hook file of a pane, or `None` when the id is not a valid pane id.
pub fn hook_file(local_dir: &Path, pty_id: &str) -> Option<PathBuf> {
    valid_pty_id(pty_id).then(|| local_dir.join(HOOKS_DIR).join(format!("{pty_id}.jsonl")))
}

/// Appends one line to the pane's hook file, making the folder if missing.
/// The line goes out in one write, so a reader never sees two lines mixed.
pub fn append_hook(local_dir: &Path, pty_id: &str, event: HookEvent, at_ms: i64) -> io::Result<()> {
    append_hook_detail(local_dir, pty_id, event, at_ms, None, None).map(|_| ())
}

/// The longest hook line the desktop reads (R5), newline included.
pub const LINE_MAX: usize = 4096;

/// `append_hook` with the stdin fields kept. Each string is cut at
/// [`DETAIL_MAX`] chars and an empty detail is left out; if the line would
/// still pass [`LINE_MAX`] bytes, the tool input, then the message, then the
/// question, then the whole detail go.
/// `session` is kept only when [`valid_session_id`].
///
/// A `needs-input` within [`REPEAT_MS`] of a `needs-input` that is the
/// file's last line is not written: claude's `AskUserQuestion` fires
/// `PreToolUse` and `PermissionRequest` for one question. A later prompt
/// (a second permission after a denied one) still is. Returns whether a line
/// was written.
pub fn append_hook_detail(
    local_dir: &Path,
    pty_id: &str,
    event: HookEvent,
    at_ms: i64,
    detail: Option<HookDetail>,
    session: Option<&str>,
) -> io::Result<bool> {
    let path = hook_file(local_dir, pty_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad pty id"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if event == HookEvent::NeedsInput
        && last_line(&path).is_some_and(|last| {
            last.event == HookEvent::NeedsInput && (at_ms - last.at).abs() < REPEAT_MS
        })
    {
        return Ok(false);
    }
    let mut hook = HookLine {
        v: 1,
        event,
        at: at_ms,
        detail: detail
            .map(HookDetail::clipped)
            .filter(|d| *d != HookDetail::default()),
        session: session.filter(|s| valid_session_id(s)).map(str::to_owned),
    };
    let mut line = serde_json::to_string(&hook)?;
    if line.len() >= LINE_MAX {
        if let Some(d) = hook.detail.as_mut() {
            d.tool_input = None;
        }
        line = serde_json::to_string(&hook)?;
    }
    if line.len() >= LINE_MAX {
        if let Some(d) = hook.detail.as_mut() {
            d.message = None;
        }
        line = serde_json::to_string(&hook)?;
    }
    if line.len() >= LINE_MAX {
        if let Some(d) = hook.detail.as_mut() {
            d.question = None;
        }
        line = serde_json::to_string(&hook)?;
    }
    if line.len() >= LINE_MAX {
        hook.detail = None;
        line = serde_json::to_string(&hook)?;
    }
    line.push('\n');
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(line.as_bytes())?;
    Ok(true)
}

/// How close two `needs-input` lines must be to count as one, in ms.
pub const REPEAT_MS: i64 = 2000;

/// The file's last line, read from its last [`LINE_MAX`] bytes.
fn last_line(path: &Path) -> Option<HookLine> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(LINE_MAX as u64);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let text = String::from_utf8_lossy(&tail);
    let last = text.lines().rev().find(|l| !l.trim().is_empty())?;
    serde_json::from_str(last).ok()
}

impl HookDetail {
    /// Every string cut at [`DETAIL_MAX`] chars; an empty string is dropped.
    pub fn clipped(self) -> HookDetail {
        let clip = |s: Option<String>| {
            s.map(|s| s.chars().take(DETAIL_MAX).collect::<String>())
                .filter(|s| !s.trim().is_empty())
        };
        HookDetail {
            tool_name: clip(self.tool_name),
            message: clip(self.message),
            is_interrupt: self.is_interrupt,
            error: clip(self.error),
            tool_input: clip(self.tool_input),
            question: self.question,
        }
    }
}

/// How long a claude hook may run, in seconds. Must be a JSON number: claude
/// drops an entry whose timeout is a string.
const CLAUDE_TIMEOUT: u64 = 10;

/// The claude version every gated event below was seen firing on (spike,
/// 2026-11-03). [Unverified] the first version that supports each one, so
/// older installs get only `UserPromptSubmit` and `Stop`.
const CLAUDE_CHECKED: CliVersion = CliVersion(2, 1, 317);

/// One claude hook entry: the event, its matcher, the `xdev agent-hook`
/// event it writes and the first version it is offered on (`None`: always).
struct ClaudeHook {
    event: &'static str,
    matcher: Option<&'static str>,
    writes: &'static str,
    since: Option<CliVersion>,
}

/// `Notification` is left out: it fires about 6 s after `PermissionRequest`
/// and 60 s after `Stop` (`idle_prompt`), which would be a false needs-you.
/// `AskUserQuestion` fires both `PreToolUse` and `PermissionRequest`, so one
/// question may write `needs-input` twice (`append_hook_detail` drops the
/// repeat).
const CLAUDE_HOOKS: [ClaudeHook; 8] = [
    ClaudeHook {
        event: "UserPromptSubmit",
        matcher: None,
        writes: "prompt",
        since: None,
    },
    ClaudeHook {
        event: "PermissionRequest",
        matcher: Some("*"),
        writes: "needs-input",
        since: Some(CLAUDE_CHECKED),
    },
    ClaudeHook {
        event: "Elicitation",
        matcher: Some("*"),
        writes: "needs-input",
        since: Some(CLAUDE_CHECKED),
    },
    ClaudeHook {
        event: "PreToolUse",
        matcher: Some("AskUserQuestion"),
        writes: "needs-input",
        since: Some(CLAUDE_CHECKED),
    },
    ClaudeHook {
        event: "PostToolUse",
        matcher: Some("*"),
        writes: "resume",
        since: Some(CLAUDE_CHECKED),
    },
    ClaudeHook {
        event: "ElicitationResult",
        matcher: Some("*"),
        writes: "resume",
        since: Some(CLAUDE_CHECKED),
    },
    ClaudeHook {
        event: "StopFailure",
        matcher: None,
        writes: "turn-failed",
        since: Some(CLAUDE_CHECKED),
    },
    ClaudeHook {
        event: "Stop",
        matcher: None,
        writes: "turn-done",
        since: None,
    },
];

/// The claude hooks a version gets: the gated ones only on a version known to have them.
fn claude_offered(version: Option<CliVersion>) -> impl Iterator<Item = &'static ClaudeHook> {
    CLAUDE_HOOKS.iter().filter(move |h| {
        h.since
            .is_none_or(|since| version.is_some_and(|v| v >= since))
    })
}

/// The events `hook_args` makes `cli` report, each once. A codex on its
/// private home reports more (`codex_home::codex_hook_events`).
pub fn hook_events(cli: Cli, version: Option<CliVersion>) -> Vec<HookEvent> {
    match cli {
        Cli::Claude => events_of(claude_offered(version).map(|h| h.writes)),
        Cli::Codex => vec![HookEvent::TurnDone],
        _ => Vec::new(),
    }
}

/// The per-process flags that make `cli` run `xdev agent-hook <event>`; empty
/// for a CLI without hooks. Nothing is written to the CLI's own config.
/// `version` is what the CLI reported (`None`: unknown).
///
/// - `claude`: `--settings` with a hooks object; an event goes in only on a
///   version known to support it.
/// - `codex`: `-c notify=[…]`, which reports the end of a turn only: the
///   fallback for a codex that cannot get the private home.
pub fn hook_args(cli: Cli, xdev: &Path, version: Option<CliVersion>) -> Vec<String> {
    match cli {
        Cli::Claude => {
            let program = sh_quote(&slashed(xdev));
            let mut hooks = serde_json::Map::new();
            for hook in claude_offered(version) {
                let mut entry = json!({ "hooks": [{
                    "type": "command",
                    "command": format!("{program} agent-hook {}", hook.writes),
                    "timeout": CLAUDE_TIMEOUT,
                }] });
                if let Some(matcher) = hook.matcher {
                    entry["matcher"] = json!(matcher);
                }
                hooks.insert(hook.event.to_owned(), json!([entry]));
            }
            let settings = json!({ "hooks": hooks });
            vec!["--settings".to_owned(), settings.to_string()]
        }
        Cli::Codex => {
            let program = toml_quote(&xdev.to_string_lossy());
            vec![
                "-c".to_owned(),
                format!(r#"notify=[{program},"agent-hook","turn-done"]"#),
            ]
        }
        _ => Vec::new(),
    }
}

/// The path with `/` separators on Windows, where the hook shell is bash and
/// a `\` would be an escape.
fn slashed(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// One POSIX shell word in double quotes.
fn sh_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        if matches!(c, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// A TOML basic string.
fn toml_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: Option<CliVersion> = Some(CliVersion(2, 1, 317));

    #[test]
    fn hooks_off_marker_round_trips_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!hooks_off(dir.path()));
        set_hooks_off(dir.path(), false).unwrap();
        set_hooks_off(dir.path(), true).unwrap();
        set_hooks_off(dir.path(), true).unwrap();
        assert!(hooks_off(dir.path()));
        assert!(dir.path().join(HOOKS_DIR).join(HOOKS_OFF).is_file());
        set_hooks_off(dir.path(), false).unwrap();
        set_hooks_off(dir.path(), false).unwrap();
        assert!(!hooks_off(dir.path()));
    }

    fn claude_settings(version: Option<CliVersion>) -> serde_json::Value {
        let args = hook_args(Cli::Claude, Path::new("C:/x/xdev.exe"), version);
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "--settings");
        serde_json::from_str(&args[1]).unwrap()
    }

    fn events_of(v: &serde_json::Value) -> Vec<String> {
        let mut events: Vec<String> = v["hooks"].as_object().unwrap().keys().cloned().collect();
        events.sort_unstable();
        events
    }

    #[test]
    fn claude_hook_args_map_every_event_on_a_known_version() {
        let v = claude_settings(NEW);
        assert_eq!(
            events_of(&v),
            [
                "Elicitation",
                "ElicitationResult",
                "PermissionRequest",
                "PostToolUse",
                "PreToolUse",
                "Stop",
                "StopFailure",
                "UserPromptSubmit",
            ]
        );
        for (event, matcher, arg) in [
            ("UserPromptSubmit", None, "prompt"),
            ("PermissionRequest", Some("*"), "needs-input"),
            ("Elicitation", Some("*"), "needs-input"),
            ("PreToolUse", Some("AskUserQuestion"), "needs-input"),
            ("PostToolUse", Some("*"), "resume"),
            ("ElicitationResult", Some("*"), "resume"),
            ("StopFailure", None, "turn-failed"),
            ("Stop", None, "turn-done"),
        ] {
            let list = v["hooks"][event].as_array().unwrap();
            assert_eq!(list.len(), 1, "{event}");
            assert_eq!(list[0]["matcher"].as_str(), matcher, "{event}");
            let hook = &list[0]["hooks"][0];
            assert_eq!(hook["type"], "command");
            assert_eq!(
                hook["command"].as_str().unwrap(),
                format!("\"C:/x/xdev.exe\" agent-hook {arg}")
            );
        }
    }

    #[test]
    fn claude_hook_timeout_is_a_json_number() {
        let args = hook_args(Cli::Claude, Path::new("/x"), NEW);
        let v: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        for (event, list) in v["hooks"].as_object().unwrap() {
            let timeout = &list[0]["hooks"][0]["timeout"];
            assert!(timeout.is_u64(), "{event}: {timeout}");
            assert_eq!(timeout.as_u64(), Some(10));
        }
        assert!(args[1].contains(r#""timeout":10"#));
        assert!(!args[1].contains(r#""timeout":"10""#));
    }

    #[test]
    fn claude_version_gate_keeps_old_and_unknown_versions_to_two_events() {
        for version in [
            None,
            Some(CliVersion(2, 1, 316)),
            Some(CliVersion(1, 9, 999)),
        ] {
            assert_eq!(
                events_of(&claude_settings(version)),
                ["Stop", "UserPromptSubmit"],
                "{version:?}"
            );
        }
        assert_eq!(
            events_of(&claude_settings(Some(CliVersion(3, 0, 0)))).len(),
            8
        );
    }

    #[test]
    fn codex_hook_args_use_notify() {
        assert_eq!(
            hook_args(Cli::Codex, Path::new("/opt/xdev"), None),
            vec!["-c", r#"notify=["/opt/xdev","agent-hook","turn-done"]"#]
        );
    }

    #[test]
    fn gemini_has_no_hook_args() {
        assert!(hook_args(Cli::Gemini, Path::new("/x"), NEW).is_empty());
    }

    /// The words a POSIX shell makes of `text` (double quotes and `\` only).
    fn sh_words(text: &str) -> Vec<String> {
        let (mut words, mut word, mut quoted, mut chars) =
            (Vec::new(), None::<String>, false, text.chars());
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    quoted = !quoted;
                    word.get_or_insert_default();
                }
                '\\' if quoted => word.get_or_insert_default().push(chars.next().unwrap()),
                ' ' if !quoted => words.extend(word.take()),
                c => word.get_or_insert_default().push(c),
            }
        }
        words.extend(word);
        words
    }

    /// The strings of a one-line TOML array of basic strings.
    fn toml_strings(text: &str) -> Vec<String> {
        let inner = text.strip_prefix('[').unwrap().strip_suffix(']').unwrap();
        let (mut out, mut chars) = (Vec::new(), inner.chars());
        while let Some(c) = chars.next() {
            if c != '"' {
                assert_eq!(c, ',');
                continue;
            }
            let mut s = String::new();
            loop {
                match chars.next().unwrap() {
                    '"' => break,
                    '\\' => match chars.next().unwrap() {
                        '"' => s.push('"'),
                        '\\' => s.push('\\'),
                        other => panic!("escape {other}"),
                    },
                    c => s.push(c),
                }
            }
            out.push(s);
        }
        out
    }

    #[test]
    fn hook_args_quote_paths_with_spaces() {
        let odd = r#"C:/Program Files/x"y $z`w/xdev.exe"#;
        let args = hook_args(Cli::Claude, Path::new(odd), NEW);
        let v: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        let cmd = v["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert_eq!(sh_words(cmd), [odd, "agent-hook", "turn-done"]);

        let win = r#"C:\Program Files\x"y\xdev.exe"#;
        let args = hook_args(Cli::Codex, Path::new(win), None);
        assert_eq!(args[0], "-c");
        let array = args[1].strip_prefix("notify=").unwrap();
        assert_eq!(toml_strings(array), [win, "agent-hook", "turn-done"]);
    }

    #[cfg(windows)]
    #[test]
    fn claude_hook_command_uses_forward_slashes_on_windows() {
        let args = hook_args(
            Cli::Claude,
            Path::new(r"C:\Program Files\xDev\xdev.exe"),
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        let cmd = &v["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"];
        assert_eq!(
            cmd.as_str().unwrap(),
            r#""C:/Program Files/xDev/xdev.exe" agent-hook prompt"#
        );
    }

    const ID: &str = "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d";

    #[test]
    fn line_roundtrips_in_kebab_case() {
        let line = HookLine {
            v: 1,
            event: HookEvent::NeedsInput,
            at: 5,
            detail: None,
            session: None,
        };
        let text = serde_json::to_string(&line).unwrap();
        assert_eq!(text, r#"{"v":1,"event":"needs-input","at":5}"#);
        assert_eq!(serde_json::from_str::<HookLine>(&text).unwrap(), line);
    }

    #[test]
    fn line_detail_is_camel_case_and_optional() {
        let line = HookLine {
            v: 1,
            event: HookEvent::TurnFailed,
            at: 6,
            detail: Some(HookDetail {
                tool_name: Some("Bash".into()),
                error: Some("model_not_found".into()),
                ..HookDetail::default()
            }),
            session: None,
        };
        let text = serde_json::to_string(&line).unwrap();
        assert_eq!(
            text,
            r#"{"v":1,"event":"turn-failed","at":6,"detail":{"toolName":"Bash","message":null,"isInterrupt":false,"error":"model_not_found","toolInput":null}}"#
        );
        assert_eq!(serde_json::from_str::<HookLine>(&text).unwrap(), line);
        for event in ["resume", "interrupt", "attention"] {
            let old = format!(r#"{{"v":1,"event":"{event}","at":1}}"#);
            assert!(
                serde_json::from_str::<HookLine>(&old)
                    .unwrap()
                    .detail
                    .is_none()
            );
        }
    }

    #[test]
    fn valid_pty_id_takes_only_uuids() {
        assert!(valid_pty_id(ID));
        for bad in [
            "",
            "../x",
            "0B3C9A52-6F1E-4D7A-9C1B-2E4F6A8B0C1D",
            "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d/..",
            "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d-",
            "0b3c9a52-6f1e-4d7a-9c1b",
            "0b3c9a526f1e4d7a9c1b2e4f6a8b0c1d",
            "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1g",
            r"a\b",
            r"0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b\c1d",
        ] {
            assert!(!valid_pty_id(bad), "{bad}");
        }
    }

    #[test]
    fn hook_file_is_none_for_bad_ids() {
        let dir = Path::new("/l");
        assert_eq!(
            hook_file(dir, ID),
            Some(dir.join("hooks").join(format!("{ID}.jsonl")))
        );
        assert_eq!(hook_file(dir, "../../x"), None);
    }

    #[test]
    fn append_writes_one_line_per_call() {
        let dir = tempfile::tempdir().unwrap();
        append_hook(dir.path(), ID, HookEvent::Prompt, 1).unwrap();
        append_hook(dir.path(), ID, HookEvent::TurnDone, 2).unwrap();
        let text = fs::read_to_string(hook_file(dir.path(), ID).unwrap()).unwrap();
        let lines: Vec<HookLine> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(
            lines,
            vec![
                HookLine {
                    v: 1,
                    event: HookEvent::Prompt,
                    at: 1,
                    detail: None,
                    session: None,
                },
                HookLine {
                    v: 1,
                    event: HookEvent::TurnDone,
                    at: 2,
                    detail: None,
                    session: None,
                },
            ]
        );
        assert!(text.ends_with('\n'));
    }

    fn read_lines(dir: &Path) -> Vec<HookLine> {
        fs::read_to_string(hook_file(dir, ID).unwrap())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn needs_input_is_idempotent_within_the_repeat_window() {
        let dir = tempfile::tempdir().unwrap();
        let ask =
            |at| append_hook_detail(dir.path(), ID, HookEvent::NeedsInput, at, None, None).unwrap();
        assert!(ask(1000));
        // PreToolUse(AskUserQuestion) then PermissionRequest: one line.
        assert!(!ask(1300));
        // A separate prompt later in the same turn still shows.
        assert!(ask(1000 + REPEAT_MS));
        append_hook(dir.path(), ID, HookEvent::Resume, 9000).unwrap();
        assert!(ask(9100));
        let events: Vec<HookEvent> = read_lines(dir.path()).iter().map(|l| l.event).collect();
        assert_eq!(
            events,
            [
                HookEvent::NeedsInput,
                HookEvent::NeedsInput,
                HookEvent::Resume,
                HookEvent::NeedsInput
            ]
        );
    }

    #[test]
    fn detail_is_clipped_and_left_out_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let long = "é".repeat(DETAIL_MAX + 50);
        let detail = HookDetail {
            tool_name: Some("Bash".into()),
            message: Some(long),
            is_interrupt: false,
            error: Some("  ".into()),
            tool_input: None,
            question: None,
        };
        append_hook_detail(dir.path(), ID, HookEvent::TurnDone, 1, Some(detail), None).unwrap();
        append_hook_detail(
            dir.path(),
            ID,
            HookEvent::Prompt,
            2,
            Some(HookDetail::default()),
            None,
        )
        .unwrap();
        let lines = read_lines(dir.path());
        let d = lines[0].detail.as_ref().unwrap();
        assert_eq!(d.tool_name.as_deref(), Some("Bash"));
        assert_eq!(d.message.as_ref().unwrap().chars().count(), DETAIL_MAX);
        assert_eq!(d.error, None);
        assert_eq!(lines[1].detail, None);
        let text = fs::read_to_string(hook_file(dir.path(), ID).unwrap()).unwrap();
        assert!(text.lines().all(|l| l.len() < LINE_MAX));
    }

    #[test]
    fn tool_input_is_clipped_and_dropped_first() {
        let dir = tempfile::tempdir().unwrap();
        let detail = HookDetail {
            tool_name: Some("Bash".into()),
            tool_input: Some("x".repeat(DETAIL_MAX + 20)),
            ..HookDetail::default()
        };
        append_hook_detail(dir.path(), ID, HookEvent::Prompt, 1, Some(detail), None).unwrap();
        let wide = "\u{1}".repeat(DETAIL_MAX);
        let detail = HookDetail {
            tool_name: Some(wide.clone()),
            message: Some(wide.clone()),
            error: Some(wide.clone()),
            tool_input: Some(wide.clone()),
            ..HookDetail::default()
        };
        append_hook_detail(
            dir.path(),
            ID,
            HookEvent::TurnFailed,
            9000,
            Some(detail),
            None,
        )
        .unwrap();
        let lines = read_lines(dir.path());
        let d = lines[0].detail.as_ref().unwrap();
        assert_eq!(d.tool_input.as_ref().unwrap().chars().count(), DETAIL_MAX);
        let d = lines[1].detail.as_ref().unwrap();
        assert_eq!(d.tool_input, None);
        assert!(d.message.is_some());
    }

    #[test]
    fn a_line_never_passes_the_reader_cap() {
        let dir = tempfile::tempdir().unwrap();
        // Control chars escape to six bytes each in JSON.
        let wide = "\u{1}".repeat(DETAIL_MAX);
        let detail = HookDetail {
            tool_name: Some(wide.clone()),
            message: Some(wide.clone()),
            is_interrupt: true,
            error: Some(wide.clone()),
            tool_input: Some(wide.clone()),
            question: None,
        };
        append_hook_detail(dir.path(), ID, HookEvent::TurnFailed, 1, Some(detail), None).unwrap();
        let text = fs::read_to_string(hook_file(dir.path(), ID).unwrap()).unwrap();
        assert!(text.len() <= LINE_MAX, "{}", text.len());
        assert_eq!(read_lines(dir.path())[0].event, HookEvent::TurnFailed);
    }

    #[test]
    fn session_ids_are_short_and_plain() {
        assert!(valid_session_id("0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d"));
        assert!(valid_session_id("rollout_2026.11"));
        assert!(valid_session_id(&"a".repeat(SESSION_MAX)));
        let long = "a".repeat(SESSION_MAX + 1);
        for bad in ["", "a/b", r"a\b", "a b", "s\n", "é", "$(x)", long.as_str()] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn append_keeps_a_valid_session_and_drops_a_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        append_hook_detail(dir.path(), ID, HookEvent::TurnDone, 1, None, Some("s-1")).unwrap();
        append_hook_detail(dir.path(), ID, HookEvent::TurnDone, 2, None, Some("../s")).unwrap();
        let lines = read_lines(dir.path());
        assert_eq!(lines[0].session.as_deref(), Some("s-1"));
        assert_eq!(lines[1].session, None);
        let text = fs::read_to_string(hook_file(dir.path(), ID).unwrap()).unwrap();
        assert!(!text.contains("../s"), "{text}");
    }

    #[test]
    fn an_old_line_without_a_session_still_parses() {
        let old = r#"{"v":1,"event":"turn-done","at":3,"detail":{"message":"ok"}}"#;
        let line: HookLine = serde_json::from_str(old).unwrap();
        assert_eq!(line.session, None);
        assert_eq!(line.detail.unwrap().message.as_deref(), Some("ok"));
    }

    #[test]
    fn append_refuses_bad_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(append_hook(dir.path(), "../x", HookEvent::Prompt, 1).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    fn ask_detail() -> HookDetail {
        let text = include_str!("../fixtures/hooks/claude-ask-user-question.json");
        let input: serde_json::Map<String, serde_json::Value> = serde_json::from_str(text).unwrap();
        HookDetail {
            tool_name: Some("AskUserQuestion".into()),
            question: question_of(&input),
            ..HookDetail::default()
        }
    }

    #[test]
    fn a_question_round_trips_through_the_hook_file() {
        let dir = tempfile::tempdir().unwrap();
        let detail = ask_detail();
        append_hook_detail(
            dir.path(),
            ID,
            HookEvent::NeedsInput,
            1,
            Some(detail.clone()),
            None,
        )
        .unwrap();
        let lines = read_lines(dir.path());
        assert_eq!(lines[0].detail.as_ref(), Some(&detail));
        let q = lines[0].detail.as_ref().unwrap().question.as_ref().unwrap();
        assert_eq!(q.options.len(), 3);
        let text = fs::read_to_string(hook_file(dir.path(), ID).unwrap()).unwrap();
        assert!(text.contains(r#""question":{"kind":"choice""#), "{text}");
    }

    #[test]
    fn a_detail_without_a_question_writes_no_question_key() {
        let text = serde_json::to_string(&HookDetail::default()).unwrap();
        assert!(!text.contains("question"), "{text}");
    }

    #[test]
    fn an_oversized_question_goes_before_the_whole_detail() {
        let dir = tempfile::tempdir().unwrap();
        let mut detail = ask_detail();
        let wide = "\u{1}".repeat(QUESTION_MAX);
        if let Some(q) = detail.question.as_mut() {
            q.text = wide.clone();
            for o in &mut q.options {
                o.label = wide.clone();
            }
        }
        append_hook_detail(dir.path(), ID, HookEvent::NeedsInput, 1, Some(detail), None).unwrap();
        let line = &read_lines(dir.path())[0];
        let d = line.detail.as_ref().unwrap();
        assert_eq!(d.question, None);
        assert_eq!(d.tool_name.as_deref(), Some("AskUserQuestion"));
    }
}
