//! `xdev agent-hook <event>`: what an agent CLI's hook runs. It appends one
//! line to `<local_dir>/hooks/<XDEV_PTY_ID>.jsonl` for the desktop to pick up.
//! It never fails the agent's turn: every problem is one stderr line, the exit
//! code is always 0 and stdout stays empty.

use std::time::{SystemTime, UNIX_EPOCH};

use clap::ValueEnum;
use xdev_agent::{HookEvent, append_hook, valid_pty_id};

/// The events a hook reports, as written on the command line.
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Event {
    Prompt,
    NeedsInput,
    TurnDone,
}

impl From<Event> for HookEvent {
    fn from(event: Event) -> Self {
        match event {
            Event::Prompt => HookEvent::Prompt,
            Event::NeedsInput => HookEvent::NeedsInput,
            Event::TurnDone => HookEvent::TurnDone,
        }
    }
}

/// The subcommand's name, so `main` can tell a bad hook call from any other
/// bad command line.
pub const NAME: &str = "agent-hook";

/// Writes the line; any error is printed to stderr and swallowed.
pub fn run(event: Event) {
    if let Err(reason) = write(event.into()) {
        eprintln!("xdev agent-hook: {reason}");
    }
}

fn write(event: HookEvent) -> Result<(), String> {
    let id = std::env::var("XDEV_PTY_ID").map_err(|_| "XDEV_PTY_ID is not set".to_owned())?;
    if !valid_pty_id(&id) {
        return Err("XDEV_PTY_ID is not a pane id".to_owned());
    }
    let local = xdev_core::local_dir().ok_or("no local data folder")?;
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    append_hook(&local, &id, event, at).map_err(|e| e.to_string())
}
