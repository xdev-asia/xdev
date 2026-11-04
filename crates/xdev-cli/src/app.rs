//! `xdev status | worktree | terminal`: one request to the running app over
//! its endpoint (`xdev_ipc::app_dir(<local_dir>)`). Without the app they fail with
//! `app_not_running` (exit 3); the other subcommands never need it.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

use clap::{Args, Subcommand};
use serde_json::{Value, json};
use xdev_ipc::IpcError;

/// Must match the app's `APP_PROTOCOL` and `PREFIX`.
pub const APP_PROTOCOL: u32 = 1;
pub const PREFIX: &str = "xdev-app";
/// How long the CLI waits for an answer to the hello or a quick verb.
pub const ANSWER_WAIT: Duration = Duration::from_secs(30);
/// Past a `terminal.wait`'s own timeout, how long the app has to answer it.
pub const WAIT_MARGIN: Duration = Duration::from_secs(10);

/// An error the app answered with, or one met on the way there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    fn new(code: &str, message: impl Into<String>) -> AppError {
        AppError {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// The spec's exit codes: 3 no app, 4 timeout, 5 target gone, 6 app
    /// stopped, 7 denied or not approved, 2 usage, 1 anything else.
    pub fn exit_code(&self) -> u8 {
        match self.code.as_str() {
            "app_not_running" => 3,
            "timeout" => 4,
            "closed" | "not_found" => 5,
            "app_stopped" => 6,
            "denied" | "needs_approval" => 7,
            "bad_request" => 2,
            _ => 1,
        }
    }
}

/// One connection to the running app, past its hello.
pub struct Client {
    writer: xdev_ipc::Stream,
    reader: BufReader<xdev_ipc::Stream>,
    next: u64,
}

fn not_running() -> AppError {
    AppError::new(
        "app_not_running",
        "xDev is not running; start xDev and try again",
    )
}

fn app_stopped() -> AppError {
    AppError::new("app_stopped", "xDev quit before it answered")
}

/// How long a verb's answer may take: a wait its own timeout plus a margin,
/// anything else `ANSWER_WAIT`.
pub fn answer_limit(method: &str, params: &Value) -> Duration {
    if let ("terminal.wait", Some(s)) = (method, params["timeoutS"].as_u64()) {
        return Duration::from_secs(s).saturating_add(WAIT_MARGIN);
    }
    match (method, params["timeoutMs"].as_u64()) {
        ("orchestration.check" | "orchestration.ask" | "orchestration.worker-start", Some(ms)) => {
            Duration::from_millis(ms).saturating_add(WAIT_MARGIN)
        }
        _ => ANSWER_WAIT,
    }
}

pub(crate) fn io_error(e: impl std::fmt::Display) -> AppError {
    AppError::new("io", e.to_string())
}

impl Client {
    /// Reads the token in `dir`, connects and says hello. No `endpoint.json`,
    /// or one an app left behind (nothing listens on the endpoint), is
    /// `app_not_running`.
    pub fn connect(dir: &Path, prefix: &str, pty: Option<&str>) -> Result<Client, AppError> {
        match fs::metadata(dir.join("endpoint.json")) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(not_running()),
            Err(e) => return Err(io_error(e)),
        }
        let token = match xdev_ipc::read_token(dir) {
            Ok(token) => token,
            Err(IpcError::NotRunning) => return Err(not_running()),
            Err(e) => return Err(io_error(e)),
        };
        let stream = match xdev_ipc::endpoint(dir, prefix, APP_PROTOCOL).connect() {
            Ok(stream) => stream,
            Err(IpcError::NotRunning) => return Err(not_running()),
            Err(e) => return Err(io_error(e)),
        };
        let writer = stream.try_clone().map_err(io_error)?;
        let mut client = Client {
            writer,
            reader: BufReader::new(stream),
            next: 1,
        };
        let hello = json!({
            "protocol": APP_PROTOCOL,
            "token": token,
            "client": "xdev-cli",
            "caller": { "pty": pty },
        });
        client.send(&hello)?;
        let back = client
            .recv(ANSWER_WAIT)?
            .ok_or_else(|| AppError::new("denied", "the app refused the connection"))?;
        if back["ok"] != true {
            return Err(error_of(&back));
        }
        Ok(client)
    }

    fn send(&mut self, value: &Value) -> Result<(), AppError> {
        let mut line = serde_json::to_vec(value).map_err(io_error)?;
        line.push(b'\n');
        self.writer.write_all(&line).map_err(io_error)?;
        self.writer.flush().map_err(io_error)
    }

    /// The next line, or `None` when the app closed the connection. No line
    /// within `limit` is `timeout`; a connection torn down is `app_stopped`.
    fn recv(&mut self, limit: Duration) -> Result<Option<Value>, AppError> {
        // On the stream the reader reads: a clone has no deadline of its own.
        self.reader
            .get_mut()
            .set_read_deadline(Some(limit))
            .map_err(io_error)?;
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => return Ok(None),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::TimedOut => {
                return Err(AppError::new("timeout", "xDev did not answer in time"));
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::BrokenPipe
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::UnexpectedEof
                ) =>
            {
                return Err(app_stopped());
            }
            Err(e) => return Err(io_error(e)),
        }
        serde_json::from_str(&line).map(Some).map_err(io_error)
    }

    /// One request; the app's error comes back as `Err`. A connection that
    /// ends before the answer means the app went away: `app_stopped`. An
    /// answer not in by `limit` is `timeout`.
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, AppError> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        let back = self.recv(limit)?.ok_or_else(app_stopped)?;
        if back["ok"] == true {
            Ok(back["result"].clone())
        } else {
            Err(error_of(&back))
        }
    }
}

fn error_of(frame: &Value) -> AppError {
    let e = &frame["error"];
    AppError::new(
        e["code"].as_str().unwrap_or("io"),
        e["message"].as_str().unwrap_or_default(),
    )
}

#[derive(Subcommand)]
pub enum WorktreeCommand {
    /// The worktrees of the caller's repo (every repo with `--all` or
    /// outside xDev): `name<TAB>branch<TAB>status<TAB>agents<TAB>id`.
    Ps {
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// The worktree this terminal runs in.
    Current {
        #[arg(long)]
        json: bool,
    },
    /// A new worktree, by default a child of the caller's; prints
    /// `id<TAB>branch<TAB>path`. The new tab is not focused.
    Create {
        #[arg(long)]
        name: Option<String>,
        /// The ref to start from; default the repo's base.
        #[arg(long)]
        from: Option<String>,
        /// Id, unique prefix, name or path of the parent worktree.
        #[arg(long)]
        parent: Option<String>,
        /// An agent profile to open in it.
        #[arg(long)]
        agent: Option<String>,
        /// Text to type into the agent once it is ready; `-` reads stdin.
        #[arg(long)]
        prompt: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Sets the status, comment or title of a worktree (default: the caller's).
    Set {
        #[arg(long)]
        worktree: Option<String>,
        /// todo, in-progress, in-review, completed, or none.
        #[arg(long)]
        status: Option<String>,
        /// At most 2000 characters.
        #[arg(long)]
        comment: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum TerminalCommand {
    /// The tabs of a worktree (default: the caller's):
    /// `id<TAB>kind<TAB>profile<TAB>state<TAB>title`.
    List {
        #[arg(long)]
        worktree: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Waits until a tab reaches a state; prints `state<TAB>atMs`. Exit 4 at
    /// the timeout, 5 when the tab closes, 6 when xDev quits.
    Wait {
        /// Tab id or a unique prefix of one.
        #[arg(long)]
        tab: String,
        #[arg(long = "for", value_parser = ["idle", "done", "needs-you", "exit"])]
        state: String,
        /// Seconds, at most 86400.
        #[arg(long, default_value_t = 600)]
        timeout: u64,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args)]
pub struct StatusArgs {
    #[arg(long)]
    pub json: bool,
}

/// What one app verb sends: method, params and whether to print JSON.
pub fn request(
    cmd: &AppCommand,
    stdin: &mut dyn Read,
) -> Result<(&'static str, Value, bool), AppError> {
    Ok(match cmd {
        AppCommand::Orchestration(o) => return crate::orch::request(o, stdin),
        AppCommand::Status(a) => ("status", json!({}), a.json),
        AppCommand::Worktree(WorktreeCommand::Ps { all, json }) => {
            ("worktree.ps", json!({ "all": all }), *json)
        }
        AppCommand::Worktree(WorktreeCommand::Current { json }) => {
            ("worktree.current", json!({}), *json)
        }
        AppCommand::Worktree(WorktreeCommand::Create {
            name,
            from,
            parent,
            agent,
            prompt,
            json,
        }) => {
            let prompt = match prompt.as_deref() {
                Some("-") => {
                    let mut text = String::new();
                    stdin.read_to_string(&mut text).map_err(io_error)?;
                    Some(text)
                }
                other => other.map(str::to_owned),
            };
            let params = json!({ "name": name, "from": from, "parent": parent, "agent": agent, "prompt": prompt });
            ("worktree.create", params, *json)
        }
        AppCommand::Worktree(WorktreeCommand::Set {
            worktree,
            status,
            comment,
            title,
            json,
        }) => {
            let params = json!({ "worktree": worktree, "status": status, "comment": comment, "title": title });
            ("worktree.set", params, *json)
        }
        AppCommand::Terminal(TerminalCommand::List { worktree, json }) => {
            ("terminal.list", json!({ "worktree": worktree }), *json)
        }
        AppCommand::Terminal(TerminalCommand::Wait {
            tab,
            state,
            timeout,
            json,
        }) => (
            "terminal.wait",
            json!({ "tab": tab, "for": state, "timeoutS": timeout }),
            *json,
        ),
    })
}

/// The app verbs, as `main` hands them over.
pub enum AppCommand {
    Status(StatusArgs),
    Worktree(WorktreeCommand),
    Terminal(TerminalCommand),
    Orchestration(Box<crate::orch::OrchArgs>),
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => "-".to_owned(),
        Value::String(s) if s.is_empty() => "-".to_owned(),
        Value::String(s) => s.replace(['\t', '\n'], " "),
        other => other.to_string(),
    }
}

fn row_line(r: &Value) -> String {
    let agents: Vec<String> = r["agents"]
        .as_array()
        .map(|a| a.iter().map(text).collect())
        .unwrap_or_default();
    let agents = if agents.is_empty() {
        "-".to_owned()
    } else {
        agents.join(",")
    };
    let name = if r["title"].is_string() {
        &r["title"]
    } else {
        &r["name"]
    };
    format!(
        "{}\t{}\t{}\t{}\t{}",
        text(name),
        text(&r["branch"]),
        text(&r["status"]),
        agents,
        text(&r["id"])
    )
}

/// The plain text of a verb's result, one line per row.
pub fn plain(method: &str, result: &Value) -> String {
    if let Some(text) = crate::orch::plain(method, result) {
        return text;
    }
    let rows = |f: fn(&Value) -> String| -> String {
        result
            .as_array()
            .map(|a| a.iter().map(|r| f(r) + "\n").collect())
            .unwrap_or_default()
    };
    match method {
        "status" => {
            let t = &result["tabs"];
            format!(
                "version\t{}\nprotocol\t{}\nselected\t{}\ntabs\tworking={} needs-you={} done={} idle={}\n",
                text(&result["version"]),
                text(&result["protocol"]),
                text(&result["selected"]),
                text(&t["working"]),
                text(&t["needsYou"]),
                text(&t["done"]),
                text(&t["idle"]),
            )
        }
        "worktree.ps" => rows(row_line),
        "worktree.current" | "worktree.set" => row_line(result) + "\n",
        "worktree.create" => format!(
            "{}\t{}\t{}\n",
            text(&result["id"]),
            text(&result["branch"]),
            text(&result["path"])
        ),
        "terminal.list" => rows(|t| {
            format!(
                "{}\t{}\t{}\t{}\t{}",
                text(&t["id"]),
                text(&t["kind"]),
                text(&t["profile"]),
                text(&t["state"]),
                text(&t["title"])
            )
        }),
        "terminal.wait" => format!("{}\t{}\n", text(&result["state"]), text(&result["atMs"])),
        _ => format!("{result}\n"),
    }
}

/// Runs one app verb against the app whose endpoint lives in `dir`; prints
/// the result and returns the exit code.
pub fn run(cmd: &AppCommand, dir: &Path, prefix: &str) -> u8 {
    let pty = std::env::var("XDEV_PTY_ID").ok().filter(|p| !p.is_empty());
    let result = request(cmd, &mut io::stdin()).and_then(|(method, params, json)| {
        let mut client = Client::connect(dir, prefix, pty.as_deref())?;
        let limit = answer_limit(method, &params);
        let result = client.call(method, params, limit)?;
        Ok((method, result, json))
    });
    match result {
        Ok((method, result, json)) => {
            if json {
                println!("{result}");
            } else {
                print!("{}", plain(method, &result));
            }
            crate::orch::exit_for(method, &result)
        }
        Err(e) => {
            if e.message.is_empty() {
                eprintln!("error: {}", e.code);
            } else {
                eprintln!("error: {}: {}", e.code, e.message);
            }
            e.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_follow_the_spec() {
        let code = |c: &str| AppError::new(c, "").exit_code();
        assert_eq!(code("app_not_running"), 3);
        assert_eq!(code("timeout"), 4);
        assert_eq!(code("closed"), 5);
        assert_eq!(code("app_stopped"), 6);
        assert_eq!(code("denied"), 7);
        assert_eq!(code("needs_approval"), 7);
        assert_eq!(code("bad_request"), 2);
        assert_eq!(code("busy"), 1);
    }

    #[test]
    fn a_prompt_of_dash_is_read_from_stdin() {
        let cmd = AppCommand::Worktree(WorktreeCommand::Create {
            name: Some("sub".into()),
            from: None,
            parent: None,
            agent: Some("claude".into()),
            prompt: Some("-".into()),
            json: false,
        });
        let (method, params, json) = request(&cmd, &mut &b"say hi\n"[..]).unwrap();
        assert_eq!(method, "worktree.create");
        assert!(!json);
        assert_eq!(params["prompt"], "say hi\n");
        assert_eq!(params["agent"], "claude");
        assert_eq!(params["parent"], Value::Null);
    }

    #[test]
    fn plain_text_is_one_tab_separated_line_per_row() {
        let rows = json!([{ "id": "/r/a", "name": "a", "title": null, "branch": "a", "status": "in-review", "agents": ["working"] }]);
        assert_eq!(
            plain("worktree.ps", &rows),
            "a\ta\tin-review\tworking\t/r/a\n"
        );
        let wait = json!({ "state": "done", "atMs": 12 });
        assert_eq!(plain("terminal.wait", &wait), "done\t12\n");
        let status = json!({ "version": "1", "protocol": 1, "selected": null, "tabs": { "working": 1, "needsYou": 0, "done": 2, "idle": 3 } });
        assert!(plain("status", &status).contains("tabs\tworking=1 needs-you=0 done=2 idle=3\n"));
    }

    #[test]
    fn a_missing_or_stale_endpoint_file_is_app_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let err = Client::connect(dir.path(), "xdev-app-none", None)
            .err()
            .unwrap();
        assert_eq!(err.code, "app_not_running");
        // Left behind by an app that is gone: token and file, no listener.
        fs::write(
            dir.path().join("endpoint.json"),
            r#"{"name":"x","pid":4000000000,"version":"1","startedMs":1}"#,
        )
        .unwrap();
        xdev_ipc::new_token(dir.path()).unwrap();
        let err = Client::connect(dir.path(), "xdev-app-none", None)
            .err()
            .unwrap();
        assert_eq!(err.code, "app_not_running");
    }
}

#[cfg(test)]
mod endpoint_tests {
    use std::thread;

    use super::*;

    /// A fake app on a temp dir: checks the hello, then answers each request
    /// with `answer(method, params)`.
    fn fake_app(answer: fn(&str, &Value) -> Value) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        // Windows pipe names are machine-wide: one per test.
        let prefix = format!(
            "xdev-app-clitest-{}",
            dir.path().file_name().unwrap().to_string_lossy()
        );
        let listener = xdev_ipc::endpoint(dir.path(), &prefix, APP_PROTOCOL)
            .bind()
            .unwrap();
        let token = xdev_ipc::new_token(dir.path()).unwrap();
        let info =
            json!({ "name": prefix, "pid": std::process::id(), "version": "9", "startedMs": 1 });
        fs::write(dir.path().join("endpoint.json"), info.to_string()).unwrap();
        thread::spawn(move || {
            while let Ok(stream) = listener.accept() {
                let mut w = stream.try_clone().unwrap();
                let mut r = BufReader::new(stream);
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let hello: Value = serde_json::from_str(&line).unwrap();
                if hello["token"] != token.as_str() {
                    continue;
                }
                writeln!(w, "{}", json!({ "ok": true, "protocol": 1 })).unwrap();
                loop {
                    line.clear();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let req: Value = serde_json::from_str(&line).unwrap();
                    let mut back = answer(req["method"].as_str().unwrap(), &req["params"]);
                    back["id"] = req["id"].clone();
                    if back.get("drop").is_some() {
                        break;
                    }
                    if back.get("hang").is_some() {
                        // Holds the connection open and never answers.
                        loop {
                            thread::park();
                        }
                    }
                    writeln!(w, "{back}").unwrap();
                }
            }
        });
        (dir, prefix)
    }

    #[test]
    fn a_call_returns_the_result_and_errors_carry_their_code() {
        let (dir, prefix) = fake_app(|method, params| match method {
            "status" => json!({ "ok": true, "result": { "version": "9" } }),
            "terminal.wait" if params["for"] == "done" => {
                json!({ "ok": false, "error": { "code": "timeout", "message": "no" } })
            }
            _ => json!({ "drop": true }),
        });
        let mut c = Client::connect(dir.path(), &prefix, Some("p1")).unwrap();
        assert_eq!(
            c.call("status", json!({}), ANSWER_WAIT).unwrap()["version"],
            "9"
        );
        let e = c
            .call("terminal.wait", json!({ "for": "done" }), ANSWER_WAIT)
            .unwrap_err();
        assert_eq!((e.code.as_str(), e.exit_code()), ("timeout", 4));
        // The app closing mid-call is `app_stopped`.
        let e = c.call("other", json!({}), ANSWER_WAIT).unwrap_err();
        assert_eq!((e.code.as_str(), e.exit_code()), ("app_stopped", 6));
    }

    #[test]
    fn an_answer_not_in_by_the_deadline_is_timeout() {
        let (dir, prefix) = fake_app(|method, _| match method {
            "status" => json!({ "ok": true, "result": {} }),
            _ => json!({ "hang": true }),
        });
        let mut c = Client::connect(dir.path(), &prefix, None).unwrap();
        let t = std::time::Instant::now();
        let e = c
            .call("terminal.wait", json!({}), Duration::from_millis(300))
            .unwrap_err();
        assert_eq!((e.code.as_str(), e.exit_code()), ("timeout", 4));
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }

    #[test]
    fn a_wait_may_take_its_timeout_plus_a_margin() {
        let wait = answer_limit("terminal.wait", &json!({ "timeoutS": 60 }));
        assert_eq!(wait, Duration::from_secs(60) + WAIT_MARGIN);
        assert_eq!(answer_limit("status", &json!({})), ANSWER_WAIT);
        assert_eq!(answer_limit("terminal.wait", &json!({})), ANSWER_WAIT);
        for verb in ["check", "ask", "worker-start"] {
            let m = format!("orchestration.{verb}");
            let limit = answer_limit(&m, &json!({ "timeoutMs": 90_000 }));
            assert_eq!(limit, Duration::from_secs(90) + WAIT_MARGIN, "{verb}");
            assert_eq!(answer_limit(&m, &json!({})), ANSWER_WAIT, "{verb}");
        }
    }

    #[test]
    fn run_maps_the_answer_to_the_exit_code() {
        let (dir, prefix) =
            fake_app(|_, _| json!({ "ok": false, "error": { "code": "denied", "message": "no" } }));
        let cmd = AppCommand::Worktree(WorktreeCommand::Set {
            worktree: None,
            status: Some("in-review".into()),
            comment: None,
            title: None,
            json: true,
        });
        assert_eq!(run(&cmd, dir.path(), &prefix), 7);
        let ok = |_: &str, _: &Value| json!({ "ok": true, "result": [] });
        let (dir, prefix) = fake_app(ok);
        let cmd = AppCommand::Terminal(TerminalCommand::List {
            worktree: None,
            json: false,
        });
        assert_eq!(run(&cmd, dir.path(), &prefix), 0);
    }

    #[test]
    fn a_wrong_token_is_refused() {
        let (dir, prefix) = fake_app(|_, _| json!({ "ok": true, "result": null }));
        xdev_ipc::new_token(dir.path()).unwrap();
        let e = Client::connect(dir.path(), &prefix, None).err().unwrap();
        assert_eq!(e.code, "denied");
    }
}
