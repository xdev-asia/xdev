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
//!   `Notification`: not checked (print mode never asks the person).
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

/// The folder under `local_dir` that holds one `<pty_id>.jsonl` per pane.
pub const HOOKS_DIR: &str = "hooks";

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
}

/// The longest string a [`HookDetail`] field keeps, in chars.
pub const DETAIL_MAX: usize = 180;

/// One line of a hook file. `detail` is left out when empty, so v1 lines
/// written before it existed still read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookLine {
    pub v: u32,
    pub event: HookEvent,
    /// Unix time in milliseconds.
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<HookDetail>,
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
    let path = hook_file(local_dir, pty_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad pty id"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_string(&HookLine {
        v: 1,
        event,
        at: at_ms,
        detail: None,
    })?;
    line.push('\n');
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(line.as_bytes())
}

/// The per-process flags that make `cli` run `xdev agent-hook <event>`; empty
/// for a CLI without hooks. Nothing is written to the CLI's own config.
///
/// - `claude`: `--settings` with a hooks object for `UserPromptSubmit`,
///   `Notification` and `Stop`.
/// - `codex`: `-c notify=[…]`, which reports the end of a turn only.
pub fn hook_args(cli: Cli, xdev: &Path) -> Vec<String> {
    match cli {
        Cli::Claude => {
            let hook = |event: &str| {
                json!([{ "hooks": [{
                    "type": "command",
                    "command": format!("{} agent-hook {event}", sh_quote(&slashed(xdev))),
                }] }])
            };
            let settings = json!({ "hooks": {
                "UserPromptSubmit": hook("prompt"),
                "Notification": hook("needs-input"),
                "Stop": hook("turn-done"),
            } });
            vec!["--settings".to_owned(), settings.to_string()]
        }
        Cli::Codex => {
            let program = toml_quote(&xdev.to_string_lossy());
            vec![
                "-c".to_owned(),
                format!(r#"notify=[{program},"agent-hook","turn-done"]"#),
            ]
        }
        Cli::Gemini => Vec::new(),
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

    #[test]
    fn claude_hook_args_name_three_events() {
        let args = hook_args(Cli::Claude, Path::new("C:/x/xdev.exe"));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "--settings");
        let v: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        for (event, arg) in [
            ("UserPromptSubmit", "prompt"),
            ("Notification", "needs-input"),
            ("Stop", "turn-done"),
        ] {
            assert_eq!(v["hooks"][event][0]["hooks"][0]["type"], "command");
            let cmd = v["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert_eq!(cmd, format!("\"C:/x/xdev.exe\" agent-hook {arg}"));
        }
    }

    #[test]
    fn codex_hook_args_use_notify() {
        assert_eq!(
            hook_args(Cli::Codex, Path::new("/opt/xdev")),
            vec!["-c", r#"notify=["/opt/xdev","agent-hook","turn-done"]"#]
        );
    }

    #[test]
    fn gemini_has_no_hook_args() {
        assert!(hook_args(Cli::Gemini, Path::new("/x")).is_empty());
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
        let args = hook_args(Cli::Claude, Path::new(odd));
        let v: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        let cmd = v["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert_eq!(sh_words(cmd), [odd, "agent-hook", "turn-done"]);

        let win = r#"C:\Program Files\x"y\xdev.exe"#;
        let args = hook_args(Cli::Codex, Path::new(win));
        assert_eq!(args[0], "-c");
        let array = args[1].strip_prefix("notify=").unwrap();
        assert_eq!(toml_strings(array), [win, "agent-hook", "turn-done"]);
    }

    #[cfg(windows)]
    #[test]
    fn claude_hook_command_uses_forward_slashes_on_windows() {
        let args = hook_args(Cli::Claude, Path::new(r"C:\Program Files\xDev\xdev.exe"));
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
        };
        let text = serde_json::to_string(&line).unwrap();
        assert_eq!(
            text,
            r#"{"v":1,"event":"turn-failed","at":6,"detail":{"toolName":"Bash","message":null,"isInterrupt":false,"error":"model_not_found"}}"#
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
                },
                HookLine {
                    v: 1,
                    event: HookEvent::TurnDone,
                    at: 2,
                    detail: None,
                },
            ]
        );
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn append_refuses_bad_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(append_hook(dir.path(), "../x", HookEvent::Prompt, 1).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
