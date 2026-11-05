//! `terminal.show | read | send`: one tab of the running app, looked at,
//! read and typed into from the CLI.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cli_verbs::{Ctx, TabReport, bad_request, params};
use crate::endpoint::{AppError, Request};
use crate::orchestration::ReadTab;
use crate::term_tail::TailRead;

/// How many lines `terminal read` gives without `--limit`, and at most.
pub const READ_LIMIT_DEFAULT: usize = 120;
pub const READ_LIMIT_MAX: usize = 5000;
/// What a screen read asks for in chars; the UI goes by lines when asked.
const SCREEN_MAX_CHARS: u32 = 200_000;
/// How many lines `terminal show` previews.
pub const SHOW_PREVIEW_LINES: usize = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowParams {
    tab: String,
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

fn kind(t: &TabReport) -> &'static str {
    if t.agent { "agent" } else { "shell" }
}

/// `terminal.show`: what `terminal list` says of one tab, with its folder
/// and its last lines.
pub(crate) fn terminal_show(ctx: &Ctx<'_>, req: &Request) -> Result<Value, AppError> {
    let p: ShowParams = params(req)?;
    let t = ctx.board.resolve(&p.tab)?;
    let preview = ctx
        .tails
        .read(&t.id, None, SHOW_PREVIEW_LINES)
        .map(|r| r.text)
        .unwrap_or_default();
    let cwd = (ctx.cwd_of)(&t.id).map(|c| c.display().to_string());
    Ok(json!({
        "id": t.id,
        "worktree": t.worktree,
        "title": t.title,
        "kind": kind(&t),
        "profile": t.profile,
        "state": t.state(),
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value, json};

    use crate::cli_verbs::tests::{fixture, tab};

    #[test]
    fn show_reports_metadata_cwd_and_the_last_lines() {
        let f = fixture();
        let mut t = tab("p-child", &f.child, true, "working");
        t.title = Some("fix it".to_owned());
        t.last_output_ms = 42;
        f.board.replace(vec![t], None);
        let lines: String = (1..=25).map(|n| format!("line {n}\r\n")).collect();
        f.tails
            .feed("p-child", format!("\x1b[32m{lines}\x1b[0m").as_bytes());
        let r = f
            .call(Some("p-lead"), "terminal.show", json!({"tab": "p-ch"}))
            .unwrap();
        assert_eq!(r["id"], "p-child");
        assert_eq!(r["worktree"], f.child.display().to_string());
        assert_eq!(r["title"], "fix it");
        assert_eq!(r["kind"], "agent");
        assert_eq!(r["profile"], "claude");
        assert_eq!(r["state"], "working");
        assert_eq!(r["lastOutputMs"], 42);
        assert_eq!(r["cwd"], f.child.display().to_string());
        let preview = r["preview"].as_str().unwrap();
        assert!(preview.starts_with("line 6\n"), "{preview}");
        assert!(preview.ends_with("line 25\n"), "{preview}");
        assert_eq!(preview.lines().count(), 20);
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
}
