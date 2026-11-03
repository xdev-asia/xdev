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

/// The folder under `local_dir` that holds one `<pty_id>.jsonl` per pane.
pub const HOOKS_DIR: &str = "hooks";

/// What an agent's hook reported: a prompt was sent, it waits for the person, or its turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum HookEvent {
    Prompt,
    NeedsInput,
    TurnDone,
}

/// One line of a hook file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookLine {
    pub v: u32,
    pub event: HookEvent,
    /// Unix time in milliseconds.
    pub at: i64,
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
    })?;
    line.push('\n');
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?
        .write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d";

    #[test]
    fn line_roundtrips_in_kebab_case() {
        let line = HookLine {
            v: 1,
            event: HookEvent::NeedsInput,
            at: 5,
        };
        let text = serde_json::to_string(&line).unwrap();
        assert_eq!(text, r#"{"v":1,"event":"needs-input","at":5}"#);
        assert_eq!(serde_json::from_str::<HookLine>(&text).unwrap(), line);
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
                    at: 1
                },
                HookLine {
                    v: 1,
                    event: HookEvent::TurnDone,
                    at: 2
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
