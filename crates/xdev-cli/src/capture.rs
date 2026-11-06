//! `xdev capture`: the running app asks the OS for a screen region, as the
//! capture shortcut does. A desktop shortcut can run it where apps cannot set
//! global shortcuts (Wayland).

use clap::Args;
use serde_json::{Value, json};

#[derive(Args)]
pub struct CaptureCommand {
    #[arg(long)]
    pub json: bool,
}

/// What `xdev capture` sends: method, params and whether to print JSON.
pub fn request(cmd: &CaptureCommand) -> (&'static str, Value, bool) {
    ("capture.start", json!({}), cmd.json)
}

/// The plain text of a `capture.*` answer.
pub fn plain(method: &str, _result: &Value) -> Option<String> {
    match method {
        "capture.start" => Some("started\n".to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        command: CaptureCommand,
    }

    fn parse(args: &[&str]) -> Result<CaptureCommand, clap::Error> {
        let mut argv = vec!["xdev"];
        argv.extend_from_slice(args);
        Cli::try_parse_from(argv).map(|c| c.command)
    }

    #[test]
    fn capture_sends_start_with_no_params() {
        let (method, params, json) = request(&parse(&[]).unwrap());
        assert_eq!(method, "capture.start");
        assert_eq!(params, json!({}));
        assert!(!json);
        assert!(request(&parse(&["--json"]).unwrap()).2);
        assert!(parse(&["extra"]).is_err());
    }

    #[test]
    fn plain_start_is_one_word() {
        let r = json!({ "started": true });
        assert_eq!(plain("capture.start", &r).unwrap(), "started\n");
        assert_eq!(plain("file.open", &r), None);
    }
}
