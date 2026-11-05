//! `xdev ssh-askpass <prompt>`: what `ssh` runs as `SSH_ASKPASS` for a
//! connection the app keeps. `ssh` runs the program with the prompt as its
//! only argument, so `xdev <prompt>` with the token set lands here too.
//!
//! Asks the running app (`ssh.askpass`) with the connection's one-time token,
//! prints the answer to stdout and exits 0. A cancel, a refused token, or no
//! app exits 1, which `ssh` takes as no answer. The answer is printed once and
//! never logged.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use crate::app::{AppError, Client};

pub const NAME: &str = "ssh-askpass";
/// Set by the app on the `ssh` it starts. Must match the app's `ssh_connect::TOKEN_ENV`.
pub const TOKEN_ENV: &str = "XDEV_SSH_ASKPASS_TOKEN";
/// The app waits five minutes for the person; this leaves it room to answer.
const LIMIT: Duration = Duration::from_secs(330);

/// The prompt when `ssh` ran the CLI itself (`xdev <prompt>`): one argument
/// after the program, with a token in the environment.
pub fn implicit_prompt(args: &[OsString], token: Option<&OsStr>) -> Option<String> {
    if token.is_none_or(OsStr::is_empty) {
        return None;
    }
    match args {
        [_, prompt] => Some(prompt.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// The answer in the app's reply; `None` is a cancel.
fn answer_of(result: &Value) -> Option<String> {
    result["answer"].as_str().map(str::to_owned)
}

/// One `ssh.askpass` call to the app at `dir`.
fn ask(dir: &Path, prefix: &str, token: &str, prompt: &str) -> Result<Option<String>, AppError> {
    let mut client = Client::connect(dir, prefix, None)?;
    let result = client.call(
        "ssh.askpass",
        json!({ "token": token, "prompt": prompt }),
        LIMIT,
    )?;
    Ok(answer_of(&result))
}

/// Asks and prints; the exit code for `ssh`.
fn answer(dir: &Path, prefix: &str, token: Option<&str>, prompt: &str) -> u8 {
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        eprintln!("xdev {NAME}: not started by xDev");
        return 1;
    };
    match ask(dir, prefix, token, prompt) {
        Ok(Some(answer)) => {
            println!("{answer}");
            0
        }
        Ok(None) => 1,
        Err(e) => {
            eprintln!("xdev {NAME}: {}", e.code);
            1
        }
    }
}

/// Runs the askpass for `prompt` against the app's endpoint.
pub fn run(prompt: &str) -> u8 {
    let Some(local) = xdev_core::local_dir() else {
        eprintln!("xdev {NAME}: io");
        return 1;
    };
    let token = std::env::var(TOKEN_ENV).ok();
    answer(
        &xdev_ipc::app_dir(&local),
        crate::app::PREFIX,
        token.as_deref(),
        prompt,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::endpoint_tests::fake_app;

    fn words(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn ssh_running_the_cli_with_a_prompt_is_askpass_only_with_a_token() {
        let token = Some(OsStr::new("t"));
        assert_eq!(
            implicit_prompt(&words(&["xdev", "me@web's password: "]), token),
            Some("me@web's password: ".to_owned())
        );
        assert_eq!(implicit_prompt(&words(&["xdev", "Password:"]), None), None);
        assert_eq!(
            implicit_prompt(&words(&["xdev", "Password:"]), Some(OsStr::new(""))),
            None
        );
        assert_eq!(implicit_prompt(&words(&["xdev"]), token), None);
        assert_eq!(implicit_prompt(&words(&["xdev", "a", "b"]), token), None);
    }

    #[test]
    fn the_answer_comes_from_the_app_with_the_token() {
        let (dir, prefix) = fake_app(|method, params| match method {
            "ssh.askpass" if params["token"] == "good" && params["prompt"] == "Password:" => {
                json!({ "ok": true, "result": { "answer": "pw" } })
            }
            "ssh.askpass" if params["token"] == "good" => {
                json!({ "ok": true, "result": { "answer": null } })
            }
            _ => json!({ "ok": false, "error": { "code": "denied", "message": "no" } }),
        });
        let at = dir.path();
        assert_eq!(
            ask(at, &prefix, "good", "Password:").unwrap(),
            Some("pw".to_owned())
        );
        assert_eq!(answer(at, &prefix, Some("good"), "Password:"), 0);
    }

    #[test]
    fn a_cancel_exits_1() {
        let (dir, prefix) = fake_app(|_, _| json!({ "ok": true, "result": { "answer": null } }));
        assert_eq!(
            ask(dir.path(), &prefix, "good", "Passphrase:").unwrap(),
            None
        );
        assert_eq!(answer(dir.path(), &prefix, Some("good"), "Passphrase:"), 1);
    }

    #[test]
    fn a_refused_token_or_no_token_or_no_app_exits_1() {
        let (dir, prefix) =
            fake_app(|_, _| json!({ "ok": false, "error": { "code": "denied", "message": "no" } }));
        let e = ask(dir.path(), &prefix, "bad", "Password:").unwrap_err();
        assert_eq!(e.code, "denied");
        assert_eq!(answer(dir.path(), &prefix, Some("bad"), "Password:"), 1);
        assert_eq!(answer(dir.path(), &prefix, None, "Password:"), 1);
        assert_eq!(answer(dir.path(), &prefix, Some(""), "Password:"), 1);
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            answer(empty.path(), "xdev-app-none", Some("t"), "Password:"),
            1
        );
    }
}
