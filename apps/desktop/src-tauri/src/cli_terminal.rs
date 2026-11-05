//! `terminal.show | read | send`: one tab of the running app, looked at,
//! read and typed into from the CLI.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cli_verbs::{Ctx, TabReport, params};
use crate::endpoint::{AppError, Request};

/// How many lines `terminal show` previews.
pub const SHOW_PREVIEW_LINES: usize = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowParams {
    tab: String,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

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
}
