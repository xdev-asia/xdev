//! `xdev status | worktree | terminal`: one request to the running app over
//! its endpoint (`xdev_ipc::app_dir(<local_dir>)`). Without the app they fail with
//! `app_not_running` (exit 3); the other subcommands never need it.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

use clap::{ArgGroup, Args, Subcommand};
use serde_json::{Value, json};
use xdev_ipc::IpcError;

/// Must match the app's `APP_PROTOCOL` and `PREFIX`.
pub const APP_PROTOCOL: u32 = 1;
pub const PREFIX: &str = "xdev-app";
/// How long the CLI waits for an answer to the hello or a quick verb.
pub const ANSWER_WAIT: Duration = Duration::from_secs(30);
/// Past a `terminal.wait`'s own timeout, how long the app has to answer it.
pub const WAIT_MARGIN: Duration = Duration::from_secs(10);
/// Past a `worker-start`'s readiness timeout, how long the app has to answer:
/// more than its own slack for the UI plus the time a new worktree takes.
pub const START_MARGIN: Duration = Duration::from_secs(30);

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
    /// stopped, 7 denied or not approved, 2 usage or an ambiguous name, 1
    /// anything else.
    pub fn exit_code(&self) -> u8 {
        match self.code.as_str() {
            "app_not_running" => 3,
            "timeout" => 4,
            "closed" | "not_found" => 5,
            "app_stopped" => 6,
            "denied" | "needs_approval" => 7,
            "bad_request" | "ambiguous" => 2,
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
        ("orchestration.check" | "orchestration.ask", Some(ms)) => {
            Duration::from_millis(ms).saturating_add(WAIT_MARGIN)
        }
        ("orchestration.worker-start", Some(ms)) => {
            Duration::from_millis(ms).saturating_add(START_MARGIN)
        }
        _ => ANSWER_WAIT,
    }
}

pub(crate) fn io_error(e: impl std::fmt::Display) -> AppError {
    AppError::new("io", e.to_string())
}

pub(crate) fn bad_request(message: impl Into<String>) -> AppError {
    AppError::new("bad_request", message)
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
    /// Sets the details of a worktree (default: the caller's): status,
    /// comment, title, linked issue or pull request, parent, read state.
    Set {
        #[arg(long)]
        worktree: Option<String>,
        /// todo, in-progress, in-review, completed, or none.
        #[arg(long)]
        status: Option<String>,
        /// At most 2000 characters.
        #[arg(long)]
        comment: Option<String>,
        /// The name the sidebar shows.
        #[arg(long, visible_alias = "display-name")]
        title: Option<String>,
        /// Links an issue: its URL, a number on the origin's host, or none.
        #[arg(long, conflicts_with = "pr")]
        issue: Option<String>,
        /// Links a pull request: its URL, a number on the origin's host, or
        /// none.
        #[arg(long)]
        pr: Option<String>,
        /// Id, unique prefix, name or path of the new parent worktree.
        #[arg(long, conflicts_with = "no_parent")]
        parent_worktree: Option<String>,
        /// Takes the worktree out from under its parent.
        #[arg(long)]
        no_parent: bool,
        /// Marks the worktree unread in the sidebar.
        #[arg(long, conflicts_with = "read")]
        unread: bool,
        /// Marks the worktree read in the sidebar.
        #[arg(long)]
        read: bool,
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
    /// Metadata and the last lines of one tab (default: this terminal): one
    /// `key<TAB>value` line per field, then the last lines it printed.
    Show {
        /// Tab id or a unique prefix of one; default this terminal.
        #[arg(long, visible_alias = "terminal")]
        tab: Option<String>,
        /// Lines to show, default 50, at most 5000.
        #[arg(long)]
        lines: Option<usize>,
        #[arg(long)]
        json: bool,
    },
    /// Output of one tab: the stream by default, the rendered screen with
    /// --screen. Prints the text; with the stream, `cursor<TAB>n` on stderr
    /// to pass as --cursor next time.
    Read {
        /// Tab id or a unique prefix of one.
        #[arg(long, alias = "terminal")]
        tab: String,
        /// Lines, default 120, at most 5000.
        #[arg(long)]
        limit: Option<usize>,
        /// Only the text after this offset, from an earlier read.
        #[arg(long, conflicts_with = "screen")]
        cursor: Option<u64>,
        #[arg(long)]
        screen: bool,
        #[arg(long)]
        json: bool,
    },
    /// Type into one tab. `--text -` reads the text from stdin. Outside your
    /// worktree and its family the person is asked first.
    #[command(group(
        ArgGroup::new("what")
            .required(true)
            .multiple(true)
            .args(["text", "enter", "interrupt"])
    ))]
    Send {
        /// Tab id or a unique prefix of one.
        #[arg(long, alias = "terminal")]
        tab: String,
        /// At most 64 KiB; written as it is unless --enter goes with it.
        #[arg(long)]
        text: Option<String>,
        /// Submit: an agent gets the text as a paste and then Enter, once
        /// it is idle; a shell gets the text and Enter.
        #[arg(long)]
        enter: bool,
        /// Ctrl-C first.
        #[arg(long)]
        interrupt: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args)]
pub struct StatusArgs {
    #[arg(long)]
    pub json: bool,
}

/// `text`, or all of stdin for `-` (without a leading UTF-8 BOM).
fn or_stdin(text: Option<&str>, stdin: &mut dyn Read) -> Result<Option<String>, AppError> {
    match text {
        Some("-") => {
            let mut text = String::new();
            stdin.read_to_string(&mut text).map_err(io_error)?;
            Ok(Some(match text.strip_prefix('\u{feff}') {
                Some(rest) => rest.to_owned(),
                None => text,
            }))
        }
        other => Ok(other.map(str::to_owned)),
    }
}

/// What one app verb sends: method, params and whether to print JSON.
pub fn request(
    cmd: &AppCommand,
    stdin: &mut dyn Read,
) -> Result<(&'static str, Value, bool), AppError> {
    Ok(match cmd {
        AppCommand::Orchestration(o) => return crate::orch::request(o, stdin),
        AppCommand::File(c) => return Ok(crate::file::request(c)),
        AppCommand::Ports(a) => return Ok(crate::ports::request(a)),
        AppCommand::Capture(a) => return Ok(crate::capture::request(a)),
        AppCommand::Automations(c) => return crate::automations::request(c),
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
            let prompt = or_stdin(prompt.as_deref(), stdin)?;
            let params = json!({ "name": name, "from": from, "parent": parent, "agent": agent, "prompt": prompt });
            ("worktree.create", params, *json)
        }
        AppCommand::Worktree(WorktreeCommand::Set {
            worktree,
            status,
            comment,
            title,
            issue,
            pr,
            parent_worktree,
            no_parent,
            unread,
            read,
            json,
        }) => {
            let unread = match (unread, read) {
                (true, _) => Some(true),
                (_, true) => Some(false),
                _ => None,
            };
            let params = json!({
                "worktree": worktree,
                "status": status,
                "comment": comment,
                "title": title,
                "issue": issue,
                "pr": pr,
                "parent": parent_worktree,
                "noParent": no_parent,
                "unread": unread,
            });
            ("worktree.set", params, *json)
        }
        AppCommand::Terminal(TerminalCommand::List { worktree, json }) => {
            ("terminal.list", json!({ "worktree": worktree }), *json)
        }
        AppCommand::Terminal(TerminalCommand::Show { tab, lines, json }) => (
            "terminal.show",
            json!({ "tab": tab, "lines": lines }),
            *json,
        ),
        AppCommand::Terminal(TerminalCommand::Read {
            tab,
            limit,
            cursor,
            screen,
            json,
        }) => (
            "terminal.read",
            json!({ "tab": tab, "limit": limit, "cursor": cursor, "screen": screen }),
            *json,
        ),
        AppCommand::Terminal(TerminalCommand::Send {
            tab,
            text,
            enter,
            interrupt,
            json,
        }) => {
            let text = or_stdin(text.as_deref(), stdin)?;
            let params =
                json!({ "tab": tab, "text": text, "enter": enter, "interrupt": interrupt });
            ("terminal.send", params, *json)
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
    File(crate::file::FileCommand),
    Ports(crate::ports::PortsArgs),
    Automations(crate::automations::AutomationsCommand),
    Capture(crate::capture::CaptureCommand),
}

pub(crate) fn text(v: &Value) -> String {
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
    if let Some(text) = crate::orch::plain(method, result)
        .or_else(|| crate::file::plain(method, result))
        .or_else(|| crate::ports::plain(method, result))
        .or_else(|| crate::automations::plain(method, result))
        .or_else(|| crate::capture::plain(method, result))
    {
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
        "terminal.show" => {
            let mut out: String = [
                "id",
                "worktree",
                "title",
                "kind",
                "profile",
                "cli",
                "account",
                "state",
                "exitCode",
                "lastOutputMs",
                "cwd",
            ]
            .iter()
            .map(|k| format!("{k}\t{}\n", text(&result[*k])))
            .collect();
            let preview = result["preview"].as_str().unwrap_or_default();
            if !preview.is_empty() {
                out.push('\n');
                out.push_str(preview);
                if !preview.ends_with('\n') {
                    out.push('\n');
                }
            }
            out
        }
        "terminal.read" => result["tail"].as_str().unwrap_or_default().to_owned(),
        "terminal.send" => format!(
            "sent\t{}\t{}\n",
            text(&result["bytes"]),
            text(&result["entered"])
        ),
        _ => format!("{result}\n"),
    }
}

/// What a verb prints on stderr beside its plain text: the cursor of a read.
pub fn plain_err(method: &str, result: &Value) -> Option<String> {
    match method {
        "terminal.read" => Some(format!("cursor\t{}\n", text(&result["nextCursor"]))),
        _ => None,
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
                if let Some(note) = plain_err(method, &result) {
                    eprint!("{note}");
                }
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

    #[derive(clap::Parser)]
    struct WorktreeCli {
        #[command(subcommand)]
        command: WorktreeCommand,
    }

    fn worktree(args: &[&str]) -> Result<AppCommand, clap::Error> {
        use clap::Parser;
        let mut argv = vec!["worktree"];
        argv.extend_from_slice(args);
        WorktreeCli::try_parse_from(argv).map(|c| AppCommand::Worktree(c.command))
    }

    #[test]
    fn set_maps_every_flag() {
        let none = &mut &b""[..];
        let cmd = worktree(&[
            "set",
            "--worktree",
            "lead",
            "--display-name",
            "Lead",
            "--issue",
            "12",
            "--parent-worktree",
            "main-ish",
            "--unread",
            "--json",
        ])
        .unwrap();
        let (m, p, json) = request(&cmd, none).unwrap();
        assert_eq!(m, "worktree.set");
        assert!(json);
        assert_eq!(
            p,
            json!({
                "worktree": "lead", "status": null, "comment": null, "title": "Lead",
                "issue": "12", "pr": null, "parent": "main-ish", "noParent": false,
                "unread": true,
            })
        );
        let cmd = worktree(&["set", "--pr", "none", "--no-parent", "--read"]).unwrap();
        let (_, p, json) = request(&cmd, none).unwrap();
        assert!(!json);
        assert_eq!(p["pr"], "none");
        assert_eq!(p["noParent"], true);
        assert_eq!(p["unread"], false);
        let cmd = worktree(&["set", "--status", "todo"]).unwrap();
        assert_eq!(request(&cmd, none).unwrap().1["unread"], Value::Null);
        assert!(worktree(&["set", "--title", "a", "--display-name", "b"]).is_err());
        for clash in [
            &["set", "--issue", "1", "--pr", "2"][..],
            &["set", "--parent-worktree", "a", "--no-parent"],
            &["set", "--unread", "--read"],
        ] {
            assert!(worktree(clash).is_err(), "{clash:?}");
        }
    }

    #[derive(clap::Parser)]
    struct TerminalCli {
        #[command(subcommand)]
        command: TerminalCommand,
    }

    #[test]
    fn show_takes_the_terminal_and_lines_or_neither() {
        use clap::Parser;
        let none = &mut &b""[..];
        let parse = |args: &[&str]| {
            let argv = [&["terminal"][..], args].concat();
            AppCommand::Terminal(TerminalCli::try_parse_from(argv).unwrap().command)
        };
        let cmd = parse(&["show", "--terminal", "t1", "--lines", "5", "--json"]);
        let (m, p, json) = request(&cmd, none).unwrap();
        assert_eq!(m, "terminal.show");
        assert!(json);
        assert_eq!(p, json!({ "tab": "t1", "lines": 5 }));
        let (_, p, json) = request(&parse(&["show"]), none).unwrap();
        assert!(!json);
        assert_eq!(p, json!({ "tab": null, "lines": null }));
        let (_, p, _) = request(&parse(&["show", "--tab", "t2"]), none).unwrap();
        assert_eq!(p["tab"], "t2");
    }

    #[test]
    fn request_maps_show_read_send() {
        let none = &mut &b""[..];
        let show = AppCommand::Terminal(TerminalCommand::Show {
            tab: Some("t1".into()),
            lines: None,
            json: true,
        });
        let (m, p, json) = request(&show, none).unwrap();
        assert_eq!(
            (m, p, json),
            ("terminal.show", json!({ "tab": "t1", "lines": null }), true)
        );
        let read = AppCommand::Terminal(TerminalCommand::Read {
            tab: "t1".into(),
            limit: Some(50),
            cursor: Some(7),
            screen: false,
            json: false,
        });
        let (m, p, _) = request(&read, none).unwrap();
        assert_eq!(m, "terminal.read");
        assert_eq!(
            p,
            json!({ "tab": "t1", "limit": 50, "cursor": 7, "screen": false })
        );
        let send = AppCommand::Terminal(TerminalCommand::Send {
            tab: "t1".into(),
            text: Some("ls".into()),
            enter: true,
            interrupt: false,
            json: false,
        });
        let (m, p, _) = request(&send, none).unwrap();
        assert_eq!(m, "terminal.send");
        assert_eq!(
            p,
            json!({ "tab": "t1", "text": "ls", "enter": true, "interrupt": false })
        );
        // The app's own waits fit in the default answer wait.
        assert!(
            answer_limit("terminal.read", &json!({ "screen": true })) >= Duration::from_secs(15)
        );
        assert!(
            answer_limit("terminal.send", &json!({ "enter": true })) >= Duration::from_secs(11)
        );
    }

    #[test]
    fn send_text_dash_reads_stdin() {
        let send = AppCommand::Terminal(TerminalCommand::Send {
            tab: "t1".into(),
            text: Some("-".into()),
            enter: false,
            interrupt: false,
            json: false,
        });
        let (_, p, _) = request(&send, &mut &b"one\r\ntwo"[..]).unwrap();
        assert_eq!(p["text"], "one\r\ntwo");
        // A leading BOM (as a PowerShell pipe adds) is dropped; CRLF stays.
        let (_, p, _) = request(&send, &mut &b"\xef\xbb\xbfhi\r\n"[..]).unwrap();
        assert_eq!(p["text"], "hi\r\n");
    }

    #[test]
    fn plain_read_prints_the_text_and_the_cursor_on_stderr() {
        let read = json!({ "tail": "a\nb", "nextCursor": 42, "source": "stream" });
        assert_eq!(plain("terminal.read", &read), "a\nb");
        assert_eq!(
            plain_err("terminal.read", &read).as_deref(),
            Some("cursor\t42\n")
        );
        assert_eq!(plain_err("terminal.show", &read), None);
        let sent = json!({ "handle": "t1", "bytes": 5, "entered": true });
        assert_eq!(plain("terminal.send", &sent), "sent\t5\ttrue\n");
        let show = json!({
            "id": "t1", "worktree": "/w", "title": null, "kind": "agent", "profile": "claude",
            "cli": "claude", "account": null, "state": "idle", "exitCode": null,
            "lastOutputMs": 9, "cwd": "/w", "preview": "x\ny\n",
        });
        assert_eq!(
            plain("terminal.show", &show),
            "id\tt1\nworktree\t/w\ntitle\t-\nkind\tagent\nprofile\tclaude\ncli\tclaude\n\
             account\t-\nstate\tidle\nexitCode\t-\nlastOutputMs\t9\ncwd\t/w\n\nx\ny\n"
        );
        assert_eq!(AppError::new("ambiguous", "").exit_code(), 2);
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
pub(crate) mod endpoint_tests {
    use std::thread;

    use super::*;

    /// A fake app on a temp dir: checks the hello, then answers each request
    /// with `answer(method, params)`.
    pub(crate) fn fake_app(answer: fn(&str, &Value) -> Value) -> (tempfile::TempDir, String) {
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
        for (verb, margin) in [
            ("check", WAIT_MARGIN),
            ("ask", WAIT_MARGIN),
            ("worker-start", START_MARGIN),
        ] {
            let m = format!("orchestration.{verb}");
            let limit = answer_limit(&m, &json!({ "timeoutMs": 90_000 }));
            assert_eq!(limit, Duration::from_secs(90) + margin, "{verb}");
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
            issue: None,
            pr: None,
            parent_worktree: None,
            no_parent: false,
            unread: false,
            read: false,
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
