//! `terminal.show | read | send`: one tab of the running app, looked at,
//! read and typed into from the CLI.

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cli_verbs::{Ctx, TabReport, bad_request, downward, params};
use crate::endpoint::{AppError, Caller, Request, scope_of};
use crate::orch_pump::{ENTER_DELAY_MS, is_idle};
use crate::orchestration::ReadTab;
use crate::term_tail::TailRead;

/// How many lines `terminal read` gives without `--limit`, and at most.
pub const READ_LIMIT_DEFAULT: usize = 120;
pub const READ_LIMIT_MAX: usize = 5000;
/// What a screen read asks for in chars; the UI goes by lines when asked.
const SCREEN_MAX_CHARS: u32 = 200_000;
/// How many lines `terminal show` previews without `--lines`.
pub const SHOW_PREVIEW_LINES: usize = 50;
/// The most text one `terminal send` types.
pub const SEND_MAX_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowParams {
    /// Default: the caller's own tab.
    tab: Option<String>,
    /// Lines of the preview, 1 to `READ_LIMIT_MAX`.
    lines: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    tab: String,
    limit: Option<usize>,
    cursor: Option<u64>,
    #[serde(default)]
    screen: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    tab: String,
    text: Option<String>,
    #[serde(default)]
    enter: bool,
    #[serde(default)]
    interrupt: bool,
}

fn kind(t: &TabReport) -> &'static str {
    if t.agent { "agent" } else { "shell" }
}

/// `terminal.show`: what `terminal list` says of one tab (default: the
/// caller's), with its folder, its agent and its last lines.
pub(crate) fn terminal_show(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
) -> Result<Value, AppError> {
    let p: ShowParams = params(req)?;
    let tab = match (p.tab, &caller.pty) {
        (Some(tab), _) => tab,
        (None, Some(pty)) => pty.clone(),
        (None, None) => {
            return Err(AppError::new(
                "no_terminal",
                "not called from an xDev terminal; pass --terminal",
            ));
        }
    };
    let lines = p
        .lines
        .unwrap_or(SHOW_PREVIEW_LINES)
        .clamp(1, READ_LIMIT_MAX);
    let t = ctx.board.resolve(&tab)?;
    let preview = ctx
        .tails
        .read(&t.id, None, lines)
        .map(|r| r.text)
        .unwrap_or_default();
    let cwd = (ctx.cwd_of)(&t.id).map(|c| c.display().to_string());
    Ok(json!({
        "id": t.id,
        "worktree": t.worktree,
        "title": t.title,
        "kind": kind(&t),
        "profile": t.profile,
        "cli": t.cli,
        "account": t.account,
        "state": t.state(),
        "exitCode": t.exit_code,
        "lastOutputMs": t.last_output_ms,
        "cwd": cwd,
        "preview": preview,
    }))
}

/// The tail of tab `id`; empty at cursor 0 when it printed nothing yet.
fn stream(ctx: &Ctx<'_>, id: &str, cursor: Option<u64>, limit: usize) -> TailRead {
    ctx.tails
        .read(id, cursor, limit)
        .unwrap_or_else(|| TailRead {
            text: String::new(),
            truncated: cursor.is_some_and(|c| c > 0),
            limited: false,
            oldest_cursor: 0,
            next_cursor: 0,
            latest_cursor: 0,
            returned_line_count: 0,
        })
}

/// The last `lines` lines of the tab's screen, as the UI renders it; `None`
/// when the UI does not answer within the read wait.
fn screen(ctx: &Ctx<'_>, id: &str, lines: usize) -> Option<String> {
    let request = ctx.orch.next_read();
    let ask = ReadTab {
        request,
        tab: id.to_owned(),
        max_chars: SCREEN_MAX_CHARS,
        max_lines: Some(u32::try_from(lines).unwrap_or(u32::MAX)),
    };
    let send = || {
        if let Ok(p) = serde_json::to_value(&ask) {
            (ctx.emit)("orchestration://read-tab", p);
        }
    };
    ctx.orch.reads.ask(request, send, ctx.orch.waits.read)
}

/// `terminal.read`: the last `limit` lines the tab printed, or only those
/// after `cursor`, escape-stripped. With `screen`, the rendered screen from
/// the UI instead, or the stream (`screen-unavailable`) when it does not answer.
pub(crate) fn terminal_read(ctx: &Ctx<'_>, req: &Request) -> Result<Value, AppError> {
    let p: ReadParams = params(req)?;
    let limit = p
        .limit
        .unwrap_or(READ_LIMIT_DEFAULT)
        .clamp(1, READ_LIMIT_MAX);
    if p.screen && p.cursor.is_some() {
        return Err(bad_request(
            "a screen has no cursor: use --screen or --cursor, not both",
        ));
    }
    let t = ctx.board.resolve(&p.tab)?;
    let mut r = stream(ctx, &t.id, p.cursor, limit);
    let mut source = "stream";
    if p.screen {
        match screen(ctx, &t.id, limit) {
            Some(text) => {
                source = "screen";
                r.returned_line_count = text.lines().count();
                r.text = text;
                r.truncated = false;
                r.limited = false;
            }
            None => source = "screen-unavailable",
        }
    }
    Ok(json!({
        "handle": t.id,
        "status": t.state(),
        "source": source,
        "tail": r.text,
        "truncated": r.truncated,
        "limited": r.limited,
        "oldestCursor": r.oldest_cursor,
        "nextCursor": r.next_cursor,
        "latestCursor": r.latest_cursor,
        "returnedLineCount": r.returned_line_count,
    }))
}

/// The bytes one send writes, and whether a `\r` follows after a delay.
/// Ctrl-C first with `interrupt`. With `enter`, an agent gets the text as a
/// bracketed paste without ESC bytes (so it cannot end the paste early) and
/// the `\r` later; a shell gets text and `\r` at once. Without `enter` the
/// text goes as it is.
pub(crate) fn send_bytes(
    text: Option<&str>,
    enter: bool,
    interrupt: bool,
    agent: bool,
) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    if interrupt {
        out.push(0x03);
    }
    match text {
        Some(text) if enter && agent => {
            out.extend_from_slice(b"\x1b[200~");
            out.extend(text.bytes().filter(|b| *b != 0x1b));
            out.extend_from_slice(b"\x1b[201~");
            return (out, true);
        }
        Some(text) => out.extend_from_slice(text.as_bytes()),
        None => {}
    }
    if enter {
        out.push(b'\r');
    }
    (out, false)
}

/// `terminal.send`: types into a tab. Outside the caller's own worktree or
/// family it asks the person, as `worktree set` does.
pub(crate) fn terminal_send(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
) -> Result<Value, AppError> {
    let p: SendParams = params(req)?;
    if p.text.is_none() && !p.enter && !p.interrupt {
        return Err(bad_request(
            "nothing to send: give --text, --enter or --interrupt",
        ));
    }
    if p.text.as_ref().is_some_and(|t| t.len() > SEND_MAX_BYTES) {
        return Err(bad_request(format!(
            "--text is at most {SEND_MAX_BYTES} bytes"
        )));
    }
    let t = ctx.board.resolve(&p.tab)?;
    let closed = || AppError::new("closed", format!("tab {} has exited", t.id));
    if t.exited {
        return Err(closed());
    }
    // Ctrl-C is meant for a busy tab, so it may come with --enter.
    if p.enter && t.agent && !p.interrupt && !is_idle(&t) {
        return Err(AppError::new(
            "busy",
            format!("tab {} is {}; wait for it to be idle", t.id, t.state()),
        ));
    }
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let target = PathBuf::from(&t.worktree);
    let scope = downward(
        scope_of(me.as_deref(), &target, &ctx.registry()?),
        &all,
        me.as_deref(),
        &target,
    );
    ctx.gate("terminal.send", "send", me.as_deref(), &target, scope)?;
    let (bytes, then_enter) = send_bytes(p.text.as_deref(), p.enter, p.interrupt, t.agent);
    if !(ctx.write_pty)(&t.id, &bytes) {
        return Err(closed());
    }
    let mut written = bytes.len();
    let mut entered = p.enter && !then_enter;
    if then_enter {
        // As the wake pump: give the agent time to take the paste, then
        // press Enter only if it is still waiting for input.
        thread::sleep(Duration::from_millis(ENTER_DELAY_MS));
        let still = ctx.board.resolve(&t.id).is_ok_and(|now| is_idle(&now));
        if still && (ctx.write_pty)(&t.id, b"\r") {
            written += 1;
            entered = true;
        }
    }
    Ok(json!({ "handle": t.id, "bytes": written, "entered": entered }))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;
    use crate::cli_verbs::tests::{fixture, tab};

    #[test]
    fn show_reports_metadata_cwd_and_the_last_lines() {
        let f = fixture();
        let mut t = tab("p-child", &f.child, true, "working");
        t.title = Some("fix it".to_owned());
        t.last_output_ms = 42;
        t.cli = Some("claude".to_owned());
        f.board.replace(vec![t], None);
        let lines: String = (1..=60)
            .map(|n| {
                format!(
                    "line {n}
"
                )
            })
            .collect();
        f.tails
            .feed("p-child", format!("[32m{lines}[0m").as_bytes());
        let r = f
            .call(Some("p-lead"), "terminal.show", json!({"tab": "p-ch"}))
            .unwrap();
        assert_eq!(r["id"], "p-child");
        assert_eq!(r["worktree"], f.child.display().to_string());
        assert_eq!(r["title"], "fix it");
        assert_eq!(r["kind"], "agent");
        assert_eq!(r["profile"], "claude");
        assert_eq!(r["cli"], "claude");
        assert_eq!(r["account"], Value::Null);
        assert_eq!(r["state"], "working");
        assert_eq!(r["exitCode"], Value::Null);
        assert_eq!(r["lastOutputMs"], 42);
        assert_eq!(r["cwd"], f.child.display().to_string());
        let preview = r["preview"].as_str().unwrap();
        assert!(
            preview.starts_with(
                "line 11
"
            ),
            "{preview}"
        );
        assert!(
            preview.ends_with(
                "line 60
"
            ),
            "{preview}"
        );
        assert_eq!(preview.lines().count(), SHOW_PREVIEW_LINES);
        let r = f
            .call(None, "terminal.show", json!({"tab": "p-child", "lines": 3}))
            .unwrap();
        assert_eq!(
            r["preview"],
            "line 58
line 59
line 60
"
        );
        // 0 still shows a line.
        let r = f
            .call(None, "terminal.show", json!({"tab": "p-child", "lines": 0}))
            .unwrap();
        assert_eq!(
            r["preview"],
            "line 60
"
        );
    }

    #[test]
    fn show_defaults_to_the_callers_own_tab() {
        let f = fixture();
        f.board.replace(
            vec![
                tab("p-lead", &f.lead, false, "idle"),
                tab("p-child", &f.child, true, "working"),
            ],
            None,
        );
        let r = f.call(Some("p-lead"), "terminal.show", json!({})).unwrap();
        assert_eq!(r["id"], "p-lead");
        assert_eq!(r["kind"], "shell");
        let e = f.call(None, "terminal.show", json!({})).unwrap_err();
        assert_eq!(e.code, "no_terminal");
        // A PTY the window does not show is not found.
        let e = f
            .call(Some("p-other"), "terminal.show", json!({}))
            .unwrap_err();
        assert_eq!(e.code, "not_found");
    }

    #[test]
    fn show_of_an_unknown_tab_is_not_found() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-child", &f.child, false, "idle")], None);
        let e = f.call(None, "terminal.show", json!({"tab": "zzz"}));
        assert_eq!(e.unwrap_err().code, "not_found");
        // A tab that printed nothing shows an empty preview.
        let r = f
            .call(None, "terminal.show", json!({"tab": "p-child"}))
            .unwrap();
        assert_eq!(
            (r["kind"].as_str(), r["preview"].as_str()),
            (Some("shell"), Some(""))
        );
    }

    fn numbered(from: usize, to: usize) -> String {
        (from..=to).map(|n| format!("{n}\r\n")).collect()
    }

    #[test]
    fn read_defaults_to_120_lines_from_the_stream() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-other", &f.other, false, "idle")], None);
        f.tails.feed("p-other", numbered(1, 130).as_bytes());
        let r = f
            .call(None, "terminal.read", json!({"tab": "p-other"}))
            .unwrap();
        assert_eq!(r["handle"], "p-other");
        assert_eq!(r["status"], "idle");
        assert_eq!(r["source"], "stream");
        assert_eq!(r["returnedLineCount"], 120);
        assert_eq!(r["limited"], true);
        assert_eq!(r["truncated"], false);
        let text = r["tail"].as_str().unwrap();
        assert!(
            text.starts_with("11\n") && text.ends_with("130\n"),
            "{text}"
        );
        assert_eq!(r["oldestCursor"], 0);
        assert_eq!(r["nextCursor"], r["latestCursor"]);
    }

    #[test]
    fn read_after_a_cursor_returns_only_new_text() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-other", &f.other, false, "idle")], None);
        // Nothing printed yet: empty, at cursor 0.
        let r = f
            .call(None, "terminal.read", json!({"tab": "p-other"}))
            .unwrap();
        assert_eq!(
            (r["tail"].as_str(), r["nextCursor"].as_u64()),
            (Some(""), Some(0))
        );
        f.tails.feed("p-other", b"$ make\r\n");
        let r = f
            .call(
                None,
                "terminal.read",
                json!({"tab": "p-other", "cursor": 0}),
            )
            .unwrap();
        assert_eq!(r["tail"], "$ make\n");
        f.tails.feed("p-other", b"\x1b[1mok\x1b[0m\r\n");
        let r = f
            .call(
                None,
                "terminal.read",
                json!({"tab": "p-other", "cursor": r["nextCursor"]}),
            )
            .unwrap();
        assert_eq!(r["tail"], "ok\n");
        assert_eq!(r["returnedLineCount"], 1);
    }

    #[test]
    fn read_clamps_the_limit_to_5000() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-other", &f.other, false, "idle")], None);
        f.tails.feed("p-other", numbered(1, 5100).as_bytes());
        let read = |limit: u64| {
            f.call(
                None,
                "terminal.read",
                json!({"tab": "p-other", "limit": limit}),
            )
            .unwrap()["returnedLineCount"]
                .clone()
        };
        assert_eq!(read(99_999), 5000);
        assert_eq!(read(7), 7);
        assert_eq!(read(0), 1);
    }

    #[test]
    fn read_screen_returns_what_the_ui_answers() {
        let mut f = fixture();
        f.read_answer = Some("  top\n> prompt".to_owned());
        f.board
            .replace(vec![tab("p-other", &f.other, true, "idle")], None);
        f.tails.feed("p-other", b"streamed\n");
        let r = f
            .call(
                None,
                "terminal.read",
                json!({"tab": "p-other", "screen": true, "limit": 30}),
            )
            .unwrap();
        assert_eq!(r["source"], "screen");
        assert_eq!(r["tail"], "  top\n> prompt");
        assert_eq!(r["returnedLineCount"], 2);
        // The cursors stay those of the stream.
        assert_eq!(r["nextCursor"], 9);
        let asked: Vec<Value> = f
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "orchestration://read-tab")
            .map(|(_, p)| p.clone())
            .collect();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0]["tab"], "p-other");
        assert_eq!(asked[0]["maxLines"], 30);
    }

    #[test]
    fn read_screen_falls_back_to_the_stream_when_nobody_answers() {
        let mut f = fixture();
        // Meant to expire: the fake UI never answers.
        f.orch.waits.read = Duration::from_millis(100);
        f.board
            .replace(vec![tab("p-other", &f.other, true, "idle")], None);
        f.tails.feed("p-other", b"streamed\r\n");
        let r = f
            .call(
                None,
                "terminal.read",
                json!({"tab": "p-other", "screen": true}),
            )
            .unwrap();
        assert_eq!(r["source"], "screen-unavailable");
        assert_eq!(r["tail"], "streamed\n");
        // A screen has no cursor to read after.
        let e = f.call(
            None,
            "terminal.read",
            json!({"tab": "p-other", "screen": true, "cursor": 0}),
        );
        assert_eq!(e.unwrap_err().code, "bad_request");
    }

    #[test]
    fn send_bytes_writes_raw_text_as_it_is() {
        assert_eq!(
            send_bytes(Some("a\x1b[Ab"), false, false, true),
            (b"a\x1b[Ab".to_vec(), false)
        );
    }

    #[test]
    fn send_bytes_puts_the_interrupt_first() {
        assert_eq!(
            send_bytes(Some("ls"), false, true, false),
            (b"\x03ls".to_vec(), false)
        );
        assert_eq!(
            send_bytes(None, false, true, true),
            (b"\x03".to_vec(), false)
        );
    }

    #[test]
    fn send_bytes_pastes_into_an_agent_without_esc_and_enters_later() {
        assert_eq!(
            send_bytes(Some("hi\x1b[201~ there"), true, false, true),
            (b"\x1b[200~hi[201~ there\x1b[201~".to_vec(), true)
        );
        // Enter alone is a plain CR.
        assert_eq!(send_bytes(None, true, false, true), (b"\r".to_vec(), false));
    }

    #[test]
    fn send_bytes_types_into_a_shell_then_cr() {
        assert_eq!(
            send_bytes(Some("make test"), true, false, false),
            (b"make test\r".to_vec(), false)
        );
    }

    fn writes(f: &crate::cli_verbs::tests::Fixture) -> Vec<(String, Vec<u8>)> {
        f.pty_writes.lock().unwrap().clone()
    }

    #[test]
    fn send_to_an_idle_agent_pastes_then_enters() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-child", &f.child, true, "idle")], None);
        let started = std::time::Instant::now();
        let r = f
            .call(
                Some("p-lead"),
                "terminal.send",
                json!({"tab": "p-child", "text": "go on", "enter": true}),
            )
            .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(r["handle"], "p-child");
        assert_eq!(r["entered"], true);
        let w = writes(&f);
        assert_eq!(w.len(), 2, "{w:?}");
        assert_eq!(
            w[0],
            ("p-child".to_owned(), b"\x1b[200~go on\x1b[201~".to_vec())
        );
        assert_eq!(w[1], ("p-child".to_owned(), b"\r".to_vec()));
        assert_eq!(r["bytes"], w[0].1.len() + 1);
        // In the caller's family: nobody was asked.
        assert!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .all(|(e, _)| e != "cli://ask")
        );
    }

    #[test]
    fn send_with_enter_to_a_busy_agent_is_busy() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-child", &f.child, true, "working")], None);
        let e = f.call(
            Some("p-lead"),
            "terminal.send",
            json!({"tab": "p-child", "text": "x", "enter": true}),
        );
        assert_eq!(e.unwrap_err().code, "busy");
        assert!(writes(&f).is_empty());
        // Without --enter the bytes go through.
        let r = f
            .call(
                Some("p-lead"),
                "terminal.send",
                json!({"tab": "p-child", "text": "y"}),
            )
            .unwrap();
        assert_eq!(r["entered"], false);
        assert_eq!(writes(&f), vec![("p-child".to_owned(), b"y".to_vec())]);
    }

    #[test]
    fn send_to_an_exited_tab_is_closed() {
        let mut f = fixture();
        let mut gone = tab("p-child", &f.child, false, "idle");
        gone.exited = true;
        f.board.replace(vec![gone], None);
        let send = |f: &crate::cli_verbs::tests::Fixture| {
            f.call(
                Some("p-lead"),
                "terminal.send",
                json!({"tab": "p-child", "text": "x"}),
            )
        };
        assert_eq!(send(&f).unwrap_err().code, "closed");
        // A PTY that is gone though the board still lists it.
        f.board
            .replace(vec![tab("p-child", &f.child, false, "idle")], None);
        f.pty_alive = false;
        assert_eq!(send(&f).unwrap_err().code, "closed");
    }

    #[test]
    fn send_to_another_family_asks_and_denied_is_7() {
        let mut f = fixture();
        f.answer = Some(false);
        f.board
            .replace(vec![tab("p-other", &f.other, false, "idle")], None);
        let e = f.call(
            Some("p-lead"),
            "terminal.send",
            json!({"tab": "p-other", "text": "x"}),
        );
        assert_eq!(e.unwrap_err().code, "denied");
        assert!(writes(&f).is_empty());
        let asks: Vec<Value> = f
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "cli://ask")
            .map(|(_, p)| p.clone())
            .collect();
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0]["verb"], "terminal.send");
        assert_eq!(asks[0]["target"], f.other.display().to_string());
        // Allowed: it is typed.
        f.answer = Some(true);
        f.call(
            Some("p-lead"),
            "terminal.send",
            json!({"tab": "p-other", "text": "x"}),
        )
        .unwrap();
        assert_eq!(writes(&f), vec![("p-other".to_owned(), b"x".to_vec())]);
    }

    #[test]
    fn send_over_64_kib_is_a_bad_request() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-child", &f.child, false, "idle")], None);
        let send = |p: Value| f.call(Some("p-lead"), "terminal.send", p);
        let big = "x".repeat(SEND_MAX_BYTES + 1);
        let e = send(json!({"tab": "p-child", "text": big}));
        assert_eq!(e.unwrap_err().code, "bad_request");
        let e = send(json!({"tab": "p-child"}));
        assert_eq!(e.unwrap_err().code, "bad_request");
        assert!(writes(&f).is_empty());
        send(json!({"tab": "p-child", "text": "x".repeat(SEND_MAX_BYTES)})).unwrap();
    }
}
