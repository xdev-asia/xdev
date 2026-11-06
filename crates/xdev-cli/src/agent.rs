//! `xdev agent hooks status|on|off`: the status hooks switch outside the app.
//! It sets both halves of the switch: `status.hooks` in the desktop's
//! `settings.json` (new panes) and the `hooks/.off` marker (panes already
//! running, whose `xdev agent-hook` calls check it every time).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde_json::{Map, Value, json};
use xdev_agent::{hooks_off, set_hooks_off};

use crate::Outcome;

/// The desktop's settings file name, inside [`xdev_core::config_dir`].
const SETTINGS_FILE: &str = "settings.json";

#[derive(Subcommand)]
pub enum AgentCommand {
    /// Status hooks: the lines agent CLIs report for the pane status.
    Hooks {
        #[command(subcommand)]
        command: HooksCommand,
    },
    /// Start an agent in a new tab of an existing worktree (default: yours),
    /// as `worktree create --agent` does; prints the tab id. Needs the app.
    Launch(crate::app::AgentLaunchArgs),
}

#[derive(Subcommand)]
pub enum HooksCommand {
    /// Print `on`, `setting` and `marker`, each `on` or `off`.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Turn the hooks on: the setting on, the marker gone.
    On {
        #[arg(long)]
        json: bool,
    },
    /// Turn the hooks off: the marker first, so running panes quiet at once.
    Off {
        #[arg(long)]
        json: bool,
    },
}

pub fn run(command: AgentCommand, local_dir: &Path) -> Result<Outcome, &'static str> {
    let AgentCommand::Hooks { command } = command else {
        // `launch` goes to the app; `main` sends it there.
        return Ok(Outcome::Ok);
    };
    let settings = xdev_core::config_dir().ok_or("io")?.join(SETTINGS_FILE);
    let json = match command {
        HooksCommand::Status { json } => json,
        HooksCommand::On { json } => {
            set_setting(&settings, true)?;
            set_hooks_off(local_dir, false).map_err(|_| "io")?;
            json
        }
        HooksCommand::Off { json } => {
            set_hooks_off(local_dir, true).map_err(|_| "io")?;
            set_setting(&settings, false)?;
            json
        }
    };
    let setting = read_setting(&settings)?;
    let marker = hooks_off(local_dir);
    let on = setting && !marker;
    if json {
        let out = json!({ "on": on, "setting": setting, "marker": marker });
        println!("{out}");
    } else {
        let word = |b: bool| if b { "on" } else { "off" };
        println!("on\t{}", word(on));
        println!("setting\t{}", word(setting));
        // The marker is `on` when it is there, i.e. when it turns hooks off.
        println!("marker\t{}", word(marker));
    }
    Ok(Outcome::Ok)
}

/// The settings as JSON: `{}` when missing, `bad_settings` when it is not a
/// JSON object, so a file the app could not read is never overwritten.
fn load(file: &Path) -> Result<Map<String, Value>, &'static str> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(_) => return Err("io"),
    };
    match serde_json::from_str(&text) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err("bad_settings"),
    }
}

/// `status.hooks`, on unless set otherwise (the app's default).
fn read_setting(file: &Path) -> Result<bool, &'static str> {
    let map = load(file)?;
    Ok(map
        .get("status")
        .and_then(|s| s.get("hooks"))
        .and_then(Value::as_bool)
        .unwrap_or(true))
}

/// Sets `status.hooks`, keeping every other field as it was.
fn set_setting(file: &Path, on: bool) -> Result<(), &'static str> {
    let mut map = load(file)?;
    let status = map
        .entry("status")
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(status) = status else {
        return Err("bad_settings");
    };
    status.insert("hooks".to_owned(), Value::Bool(on));
    let text = serde_json::to_string_pretty(&Value::Object(map)).map_err(|_| "io")?;
    write_atomic(file, text.as_bytes()).map_err(|_| "io")
}

/// Writes next to `file` and renames over it, so the app never reads half a
/// file.
fn write_atomic(file: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = PathBuf::from(file);
    tmp.set_extension("json.xdev-tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, file)
}
