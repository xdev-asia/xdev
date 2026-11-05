//! Edit an issue, comment on it, list what can be set on it and read its timeline,
//! all through `gh` in the repo's main checkout.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{GhExec, ISSUE_BODY_MAX, IssueState, ok, parse_error, repo_name};
use crate::gh_review::{COMMENT_BODY_MAX, post_json};

/// Most events one timeline read returns.
pub const ISSUE_TIMELINE_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum IssueCloseReason {
    Completed,
    NotPlanned,
}

/// The parts of an issue to change. Only what is set is sent; an empty edit
/// runs no `gh` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct IssueEdit {
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<IssueState>,
    /// Used only when `state` is closed.
    pub close_reason: Option<IssueCloseReason>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
}

/// What an edit left undone. Every requested part is tried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueEditReport {
    /// Parts that failed: "state", "body" or "fields".
    pub failed: Vec<String>,
    /// The first error's text.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueLabel {
    pub name: String,
    /// Hex without `#`.
    pub color: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum IssueEventKind {
    Assigned,
    Unassigned,
    Closed,
    Reopened,
    Labeled,
    Unlabeled,
    Renamed,
    CrossReferenced,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueEvent {
    pub kind: IssueEventKind,
    pub actor: Option<String>,
    /// The assignee login, label name, new title, or `#n title` of the source.
    pub subject: Option<String>,
    pub created_at: String,
}

const TITLE_MAX: usize = 256;

/// A label or login that cannot be an argv item of its own: it would read as
/// a flag, or it spans lines.
fn bad_token(text: &str) -> bool {
    text.is_empty() || text.starts_with('-') || text.contains(['\n', '\r'])
}

fn validate(edit: &IssueEdit) -> Result<(), GitError> {
    if let Some(title) = &edit.title {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > TITLE_MAX {
            return Err(GitError::BadDraft);
        }
    }
    if let Some(body) = &edit.body
        && body.chars().count() > ISSUE_BODY_MAX
    {
        return Err(GitError::BadDraft);
    }
    let lists = [
        &edit.add_labels,
        &edit.remove_labels,
        &edit.add_assignees,
        &edit.remove_assignees,
    ];
    if lists.iter().any(|l| l.iter().any(|t| bad_token(t))) {
        return Err(GitError::BadDraft);
    }
    Ok(())
}

/// Changes the parts named in `edit`: state, then body, then title, labels and
/// assignees in one `gh issue edit`. Every requested part is tried; the
/// report names the ones that failed.
pub fn issue_edit(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    edit: &IssueEdit,
) -> Result<IssueEditReport, GitError> {
    validate(edit)?;
    let n = number.to_string();
    let mut report = IssueEditReport {
        failed: Vec::new(),
        error: None,
    };
    let mut fail = |part: &str, err: GitError| {
        report.failed.push(part.to_owned());
        report.error.get_or_insert_with(|| match err {
            GitError::Gh(text) => text,
            other => other.to_string(),
        });
    };

    if let Some(state) = &edit.state {
        let run = match state {
            IssueState::Closed => {
                let mut args = vec!["issue", "close", n.as_str()];
                match edit.close_reason {
                    Some(IssueCloseReason::Completed) => args.extend(["--reason", "completed"]),
                    Some(IssueCloseReason::NotPlanned) => args.extend(["--reason", "not planned"]),
                    None => {}
                }
                gh.run(cwd, &args, None)
            }
            IssueState::Open => gh.run(cwd, &["issue", "reopen", &n], None),
        };
        if let Err(e) = run.and_then(ok) {
            fail("state", e);
        }
    }

    if let Some(body) = &edit.body {
        let sent = repo_name(gh, cwd).and_then(|repo| {
            let text = serde_json::json!({ "body": body }).to_string();
            let out = gh.run(
                cwd,
                &[
                    "api",
                    "--method",
                    "PATCH",
                    &format!("repos/{repo}/issues/{number}"),
                    "--input",
                    "-",
                ],
                Some(&text),
            )?;
            ok(out).map(drop)
        });
        if let Err(e) = sent {
            fail("body", e);
        }
    }

    let title = edit.title.as_deref().map(str::trim);
    let has_fields = title.is_some()
        || !edit.add_labels.is_empty()
        || !edit.remove_labels.is_empty()
        || !edit.add_assignees.is_empty()
        || !edit.remove_assignees.is_empty();
    if has_fields {
        let mut args: Vec<&str> = vec!["issue", "edit", &n];
        if let Some(title) = title {
            args.extend(["--title", title]);
        }
        for (flag, items) in [
            ("--add-label", &edit.add_labels),
            ("--remove-label", &edit.remove_labels),
            ("--add-assignee", &edit.add_assignees),
            ("--remove-assignee", &edit.remove_assignees),
        ] {
            for item in items {
                args.extend([flag, item.as_str()]);
            }
        }
        if let Err(e) = gh.run(cwd, &args, None).and_then(ok) {
            fail("fields", e);
        }
    }
    Ok(report)
}

/// Posts a comment; the body goes on stdin as JSON.
pub fn issue_comment(gh: &dyn GhExec, cwd: &Path, number: u64, body: &str) -> Result<(), GitError> {
    if body.trim().is_empty() {
        return Err(GitError::EmptyComment);
    }
    if body.chars().count() > COMMENT_BODY_MAX {
        return Err(GitError::CommentTooLarge);
    }
    let repo = repo_name(gh, cwd)?;
    post_json(
        gh,
        cwd,
        &format!("repos/{repo}/issues/{number}/comments"),
        &serde_json::json!({ "body": body }),
    )
}

/// The repo's labels, at most 200.
pub fn issue_labels(gh: &dyn GhExec, cwd: &Path) -> Result<Vec<IssueLabel>, GitError> {
    let out = ok(gh.run(
        cwd,
        &["label", "list", "--json", "name,color", "--limit", "200"],
        None,
    )?)?;
    serde_json::from_str(&out.stdout).map_err(parse_error)
}

/// Logins an issue of the repo can be assigned to. `--jq` prints one login
/// per line however many pages there are.
pub fn issue_assignable(gh: &dyn GhExec, cwd: &Path) -> Result<Vec<String>, GitError> {
    let repo = repo_name(gh, cwd)?;
    let out = ok(gh.run(
        cwd,
        &[
            "api",
            &format!("repos/{repo}/assignees"),
            "--paginate",
            "--jq",
            ".[].login",
        ],
        None,
    )?)?;
    Ok(out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect())
}

/// One event of the timeline, or `None` for a kind that is not read.
fn read_event(value: &serde_json::Value) -> Option<IssueEvent> {
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_owned);
    let actor = text(value.pointer("/actor/login"));
    let (kind, subject) = match value.get("event")?.as_str()? {
        "assigned" => (
            IssueEventKind::Assigned,
            text(value.pointer("/assignee/login")),
        ),
        "unassigned" => (
            IssueEventKind::Unassigned,
            text(value.pointer("/assignee/login")),
        ),
        "closed" => (IssueEventKind::Closed, None),
        "reopened" => (IssueEventKind::Reopened, None),
        "labeled" => (IssueEventKind::Labeled, text(value.pointer("/label/name"))),
        "unlabeled" => (
            IssueEventKind::Unlabeled,
            text(value.pointer("/label/name")),
        ),
        "renamed" => (IssueEventKind::Renamed, text(value.pointer("/rename/to"))),
        "cross-referenced" => {
            let issue = value.pointer("/source/issue")?;
            let number = issue.get("number")?.as_u64()?;
            let title = issue.get("title").and_then(|t| t.as_str()).unwrap_or("");
            (
                IssueEventKind::CrossReferenced,
                Some(format!("#{number} {title}").trim_end().to_owned()),
            )
        }
        _ => return None,
    };
    Some(IssueEvent {
        kind,
        actor,
        subject,
        created_at: text(value.get("created_at"))?,
    })
}

/// The issue's events, oldest first, known kinds only, at most
/// `ISSUE_TIMELINE_MAX`. `--jq '.[]'` prints one event per line however many
/// pages there are; a line that does not parse is dropped.
pub fn issue_timeline(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
) -> Result<Vec<IssueEvent>, GitError> {
    let repo = repo_name(gh, cwd)?;
    let out = ok(gh.run(
        cwd,
        &[
            "api",
            &format!("repos/{repo}/issues/{number}/timeline"),
            "--paginate",
            "--jq",
            ".[]",
        ],
        None,
    )?)?;
    Ok(out
        .stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| read_event(&v))
        .take(ISSUE_TIMELINE_MAX)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gh::GhOutput;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    type Call = (Vec<String>, Option<String>);

    struct Fake {
        calls: RefCell<Vec<Call>>,
        script: RefCell<VecDeque<GhOutput>>,
    }

    impl Fake {
        fn new(script: Vec<GhOutput>) -> Fake {
            Fake {
                calls: RefCell::new(Vec::new()),
                script: RefCell::new(script.into()),
            }
        }
    }

    impl GhExec for Fake {
        fn run(&self, _: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError> {
            self.calls.borrow_mut().push((
                args.iter().map(|s| s.to_string()).collect(),
                stdin.map(str::to_owned),
            ));
            Ok(self.script.borrow_mut().pop_front().expect("scripted"))
        }
    }

    fn out(status: i32, stdout: &str, stderr: &str) -> GhOutput {
        GhOutput {
            status: Some(status),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    fn cwd() -> &'static Path {
        Path::new(".")
    }

    fn args(call: &Call) -> Vec<&str> {
        call.0.iter().map(String::as_str).collect()
    }

    #[test]
    fn issue_edit_runs_close_with_reason() {
        let fake = Fake::new(vec![out(0, "", ""), out(0, "", ""), out(0, "", "")]);
        let edit = IssueEdit {
            state: Some(IssueState::Closed),
            close_reason: Some(IssueCloseReason::NotPlanned),
            ..IssueEdit::default()
        };
        let report = issue_edit(&fake, cwd(), 7, &edit).unwrap();
        assert!(report.failed.is_empty() && report.error.is_none());
        let reopen = IssueEdit {
            state: Some(IssueState::Open),
            ..IssueEdit::default()
        };
        issue_edit(&fake, cwd(), 7, &reopen).unwrap();
        let done = IssueEdit {
            state: Some(IssueState::Closed),
            close_reason: Some(IssueCloseReason::Completed),
            ..IssueEdit::default()
        };
        issue_edit(&fake, cwd(), 7, &done).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(
            args(&calls[0]),
            ["issue", "close", "7", "--reason", "not planned"]
        );
        assert_eq!(args(&calls[1]), ["issue", "reopen", "7"]);
        assert_eq!(
            args(&calls[2]),
            ["issue", "close", "7", "--reason", "completed"]
        );
    }

    #[test]
    fn issue_edit_sends_body_on_stdin() {
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(0, "{}", ""),
        ]);
        let edit = IssueEdit {
            body: Some("line 1\r\n\"quoted\" é".into()),
            ..IssueEdit::default()
        };
        let report = issue_edit(&fake, cwd(), 7, &edit).unwrap();
        assert!(report.failed.is_empty());
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            args(&calls[1]),
            [
                "api",
                "--method",
                "PATCH",
                "repos/o/r/issues/7",
                "--input",
                "-"
            ]
        );
        let sent: serde_json::Value = serde_json::from_str(calls[1].1.as_ref().unwrap()).unwrap();
        assert_eq!(
            sent,
            serde_json::json!({ "body": "line 1\r\n\"quoted\" é" })
        );
    }

    #[test]
    fn issue_edit_batches_labels_and_assignees_in_one_call() {
        let fake = Fake::new(vec![out(0, "", "")]);
        let edit = IssueEdit {
            title: Some("  New title ".into()),
            add_labels: vec!["bug".into(), "needs, comma".into()],
            remove_labels: vec!["docs".into()],
            add_assignees: vec!["octo".into()],
            remove_assignees: vec!["mona".into()],
            ..IssueEdit::default()
        };
        issue_edit(&fake, cwd(), 7, &edit).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            args(&calls[0]),
            [
                "issue",
                "edit",
                "7",
                "--title",
                "New title",
                "--add-label",
                "bug",
                "--add-label",
                "needs, comma",
                "--remove-label",
                "docs",
                "--add-assignee",
                "octo",
                "--remove-assignee",
                "mona"
            ]
        );
    }

    #[test]
    fn issue_edit_empty_runs_nothing() {
        let fake = Fake::new(vec![]);
        let report = issue_edit(&fake, cwd(), 7, &IssueEdit::default()).unwrap();
        assert!(report.failed.is_empty() && report.error.is_none());
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn issue_edit_reports_partial_failure() {
        let fake = Fake::new(vec![
            out(1, "", "boom state"),
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(0, "{}", ""),
            out(1, "", "boom fields"),
        ]);
        let edit = IssueEdit {
            state: Some(IssueState::Open),
            body: Some("b".into()),
            add_labels: vec!["bug".into()],
            ..IssueEdit::default()
        };
        let report = issue_edit(&fake, cwd(), 7, &edit).unwrap();
        assert_eq!(report.failed, ["state", "fields"]);
        assert_eq!(report.error.as_deref(), Some("boom state"));
        assert_eq!(fake.calls.borrow().len(), 4);
    }

    #[test]
    fn issue_edit_rejects_dash_label() {
        let fake = Fake::new(vec![]);
        for edit in [
            IssueEdit {
                add_labels: vec!["--web".into()],
                ..IssueEdit::default()
            },
            IssueEdit {
                remove_assignees: vec!["a\nb".into()],
                ..IssueEdit::default()
            },
            IssueEdit {
                title: Some("  ".into()),
                ..IssueEdit::default()
            },
            IssueEdit {
                title: Some("x".repeat(TITLE_MAX + 1)),
                ..IssueEdit::default()
            },
            IssueEdit {
                body: Some("x".repeat(ISSUE_BODY_MAX + 1)),
                ..IssueEdit::default()
            },
        ] {
            assert!(matches!(
                issue_edit(&fake, cwd(), 7, &edit),
                Err(GitError::BadDraft)
            ));
        }
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn issue_comment_posts_json_on_stdin() {
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(0, "{}", ""),
        ]);
        issue_comment(
            &fake,
            cwd(),
            7,
            "hello \"you\"
bye é",
        )
        .unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(
            args(&calls[1]),
            [
                "api",
                "--method",
                "POST",
                "repos/o/r/issues/7/comments",
                "--input",
                "-"
            ]
        );
        let sent: serde_json::Value = serde_json::from_str(calls[1].1.as_ref().unwrap()).unwrap();
        assert_eq!(
            sent,
            serde_json::json!({ "body": "hello \"you\"
bye é" })
        );
    }

    #[test]
    fn issue_comment_rejects_empty() {
        let fake = Fake::new(vec![]);
        assert!(matches!(
            issue_comment(
                &fake,
                cwd(),
                7,
                " 
	"
            ),
            Err(GitError::EmptyComment)
        ));
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn issue_comment_rejects_over_limit() {
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(0, "{}", ""),
        ]);
        let huge = "x".repeat(COMMENT_BODY_MAX + 1);
        assert!(matches!(
            issue_comment(&fake, cwd(), 7, &huge),
            Err(GitError::CommentTooLarge)
        ));
        assert!(fake.calls.borrow().is_empty());
        issue_comment(&fake, cwd(), 7, &"x".repeat(COMMENT_BODY_MAX)).unwrap();
    }

    #[test]
    fn issue_labels_parses_names_and_colours() {
        let fake = Fake::new(vec![out(
            0,
            r#"[{"name":"bug","color":"d73a4a","description":"x"},{"name":"ui","color":"a2eeef"}]"#,
            "",
        )]);
        let labels = issue_labels(&fake, cwd()).unwrap();
        assert_eq!(
            labels,
            [
                IssueLabel {
                    name: "bug".into(),
                    color: "d73a4a".into()
                },
                IssueLabel {
                    name: "ui".into(),
                    color: "a2eeef".into()
                }
            ]
        );
        assert_eq!(
            args(&fake.calls.borrow()[0]),
            ["label", "list", "--json", "name,color", "--limit", "200"]
        );
        let bad = Fake::new(vec![out(0, "nope", "")]);
        assert!(issue_labels(&bad, cwd()).is_err());
    }

    #[test]
    fn issue_assignable_reads_ndjson_pages() {
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(
                0,
                "octo
mona

hubot
",
                "",
            ),
        ]);
        assert_eq!(
            issue_assignable(&fake, cwd()).unwrap(),
            ["octo", "mona", "hubot"]
        );
        assert_eq!(
            args(&fake.calls.borrow()[1]),
            [
                "api",
                "repos/o/r/assignees",
                "--paginate",
                "--jq",
                ".[].login"
            ]
        );
    }

    fn event_line(kind: &str, extra: &str, at: &str) -> String {
        format!(r#"{{"event":"{kind}","actor":{{"login":"hubot"}},"created_at":"{at}"{extra}}}"#)
    }

    #[test]
    fn issue_timeline_keeps_known_events_in_order() {
        let lines = [
            event_line("labeled", r#","label":{"name":"bug","color":"f00"}"#, "t1"),
            event_line("assigned", r#","assignee":{"login":"octo"}"#, "t2"),
            event_line("unassigned", r#","assignee":{"login":"mona"}"#, "t3"),
            event_line("renamed", r#","rename":{"from":"a","to":"b"}"#, "t4"),
            event_line("closed", "", "t5"),
            event_line("reopened", "", "t6"),
            event_line("unlabeled", r#","label":{"name":"bug"}"#, "t7"),
            event_line(
                "cross-referenced",
                r#","source":{"type":"issue","issue":{"number":12,"title":"Other"}}"#,
                "t8",
            ),
        ]
        .join(
            "
",
        );
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(0, &lines, ""),
        ]);
        let events = issue_timeline(&fake, cwd(), 7).unwrap();
        let got: Vec<_> = events
            .iter()
            .map(|e| (e.kind, e.subject.as_deref(), e.created_at.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (IssueEventKind::Labeled, Some("bug"), "t1"),
                (IssueEventKind::Assigned, Some("octo"), "t2"),
                (IssueEventKind::Unassigned, Some("mona"), "t3"),
                (IssueEventKind::Renamed, Some("b"), "t4"),
                (IssueEventKind::Closed, None, "t5"),
                (IssueEventKind::Reopened, None, "t6"),
                (IssueEventKind::Unlabeled, Some("bug"), "t7"),
                (IssueEventKind::CrossReferenced, Some("#12 Other"), "t8"),
            ]
        );
        assert_eq!(events[0].actor.as_deref(), Some("hubot"));
        assert_eq!(
            args(&fake.calls.borrow()[1]),
            [
                "api",
                "repos/o/r/issues/7/timeline",
                "--paginate",
                "--jq",
                ".[]"
            ]
        );
    }

    #[test]
    fn issue_timeline_drops_unknown() {
        let lines = [
            event_line("committed", "", "t1"),
            "not json".to_owned(),
            event_line("subscribed", "", "t2"),
            event_line("closed", "", "t3"),
            r#"{"event":"closed","actor":{"login":"x"}}"#.to_owned(),
        ]
        .join(
            "
",
        );
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(0, &lines, ""),
        ]);
        let events = issue_timeline(&fake, cwd(), 7).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, IssueEventKind::Closed);
    }

    #[test]
    fn issue_timeline_caps_at_200() {
        let lines: Vec<String> = (0..ISSUE_TIMELINE_MAX + 30)
            .map(|i| event_line("closed", "", &format!("t{i}")))
            .collect();
        let fake = Fake::new(vec![
            out(0, r#"{"nameWithOwner":"o/r"}"#, ""),
            out(
                0,
                &lines.join(
                    "
",
                ),
                "",
            ),
        ]);
        let events = issue_timeline(&fake, cwd(), 7).unwrap();
        assert_eq!(events.len(), ISSUE_TIMELINE_MAX);
        assert_eq!(events[0].created_at, "t0");
    }
}
