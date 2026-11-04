//! Pull requests and checks through the `gh` program. The program sits behind
//! `GhExec` so tests never run the real one.

use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::GitError;

/// A login prompt or a slow network must not hang the UI.
const TIMEOUT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(20);
const PR_FIELDS: &str = "number,url,state,isDraft,title,baseRefName,headRefName";
const ISSUE_FIELDS: &str = "number,url,state,title,labels,assignees,author,updatedAt";
/// Most issues one list call returns.
pub const ISSUE_LIMIT_MAX: u32 = 200;
/// Chars kept of an issue body or a comment; the rest is cut.
pub const ISSUE_BODY_MAX: usize = 64 * 1024;

pub struct GhOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub trait GhExec {
    fn run(&self, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError>;
}

/// Runs `gh` from `PATH`.
pub struct SystemGh;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrView {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub url: String,
    pub state: PrState,
    pub title: String,
    pub base: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum CheckBucket {
    Pass,
    Fail,
    Pending,
    Skipping,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub workflow: Option<String>,
    pub bucket: CheckBucket,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrDraft {
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u64,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    title: String,
    base_ref_name: String,
    head_ref_name: String,
}

#[derive(Deserialize)]
struct RawCheck {
    name: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    workflow: String,
}

impl From<RawPr> for PrView {
    fn from(raw: RawPr) -> PrView {
        let state = match raw.state.as_str() {
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ if raw.is_draft => PrState::Draft,
            _ => PrState::Open,
        };
        PrView {
            number: raw.number,
            url: raw.url,
            state,
            title: raw.title,
            base: raw.base_ref_name,
            head: raw.head_ref_name,
        }
    }
}

impl From<RawCheck> for Check {
    fn from(raw: RawCheck) -> Check {
        // `gh` may add buckets later; waiting is the safe reading.
        let bucket = match raw.bucket.as_str() {
            "pass" => CheckBucket::Pass,
            "fail" => CheckBucket::Fail,
            "skipping" => CheckBucket::Skipping,
            "cancel" => CheckBucket::Cancel,
            _ => CheckBucket::Pending,
        };
        let some = |s: String| (!s.is_empty()).then_some(s);
        Check {
            name: raw.name,
            workflow: some(raw.workflow),
            bucket,
            link: some(raw.link),
        }
    }
}

/// The one reading of a failed `gh` run.
fn classify(out: &GhOutput) -> GitError {
    if out.stderr.contains("gh auth login") {
        GitError::GhAuth
    } else if out.stderr.contains("none of the git remotes") {
        GitError::NotGithub
    } else {
        GitError::Gh(out.stderr.trim().to_owned())
    }
}

fn parse_error(e: serde_json::Error) -> GitError {
    GitError::Gh(format!("unexpected gh output: {e}"))
}

fn ok(out: GhOutput) -> Result<GhOutput, GitError> {
    if out.status == Some(0) {
        Ok(out)
    } else {
        Err(classify(&out))
    }
}

/// `None` when the current branch has no pull request.
pub fn pr_view(gh: &dyn GhExec, cwd: &Path) -> Result<Option<PrView>, GitError> {
    let out = gh.run(cwd, &["pr", "view", "--json", PR_FIELDS], None)?;
    if out.status != Some(0) {
        if out.stderr.contains("no pull requests found") {
            return Ok(None);
        }
        return Err(classify(&out));
    }
    let raw: RawPr = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(Some(raw.into()))
}

pub fn pr_create(
    gh: &dyn GhExec,
    cwd: &Path,
    head: &str,
    draft: &PrDraft,
) -> Result<PrView, GitError> {
    let mut args = vec![
        "pr",
        "create",
        "--base",
        &draft.base,
        "--head",
        head,
        "--title",
        &draft.title,
        "--body-file",
        "-",
    ];
    if draft.draft {
        args.push("--draft");
    }
    ok(gh.run(cwd, &args, Some(&draft.body))?)?;
    pr_view(gh, cwd)?.ok_or_else(|| GitError::Gh("the new pull request was not found".into()))
}

pub fn pr_checks(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<Vec<Check>, GitError> {
    let number = number.to_string();
    let out = gh.run(
        cwd,
        &[
            "pr",
            "checks",
            &number,
            "--json",
            "name,state,bucket,link,workflow",
        ],
        None,
    )?;
    // Exit 8 means checks are pending and 1 that one failed; the JSON is
    // complete either way.
    if let Ok(raw) = serde_json::from_str::<Vec<RawCheck>>(&out.stdout) {
        return Ok(raw.into_iter().map(Check::from).collect());
    }
    if out.stderr.contains("no checks reported") {
        return Ok(Vec::new());
    }
    Err(classify(&out))
}

pub fn pr_open_web(gh: &dyn GhExec, cwd: &Path, checks: bool) -> Result<(), GitError> {
    let sub = if checks { "checks" } else { "view" };
    ok(gh.run(cwd, &["pr", sub, "--web"], None)?)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub url: String,
    pub state: IssueState,
    pub title: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub author: Option<String>,
    /// RFC 3339 as `gh` prints it.
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Issue,
    pub body: String,
    pub comments: Vec<IssueComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueQuery {
    /// `None` reads as open.
    pub state: Option<IssueState>,
    pub assignee_me: bool,
    /// Passed as `--search`; at most 256 chars.
    pub search: Option<String>,
    /// Default 100, capped at `ISSUE_LIMIT_MAX`.
    pub limit: Option<u32>,
}

pub fn issue_list(_gh: &dyn GhExec, _cwd: &Path, _q: &IssueQuery) -> Result<Vec<Issue>, GitError> {
    todo!("B2")
}

pub fn issue_view(_gh: &dyn GhExec, _cwd: &Path, _number: u64) -> Result<IssueDetail, GitError> {
    todo!("B3")
}

/// "#123", "123", or "https://github.com/<owner>/<repo>/issues/123" gives
/// (`owner/repo` or `None`, 123).
pub fn parse_issue_ref(text: &str) -> Option<(Option<String>, u64)> {
    let text = text.trim();
    let number = |s: &str| {
        let digits = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        s.parse::<u64>().ok().filter(|n| digits && *n > 0)
    };
    if let Some(rest) = text.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
        return match parts.as_slice() {
            [owner, repo, "issues", n] if !owner.is_empty() && !repo.is_empty() => {
                number(n).map(|n| (Some(format!("{owner}/{repo}")), n))
            }
            _ => None,
        };
    }
    number(text.strip_prefix('#').unwrap_or(text)).map(|n| (None, n))
}

fn spawn_error(e: io::Error) -> GitError {
    match e.kind() {
        io::ErrorKind::NotFound => GitError::GhMissing,
        _ => GitError::Io(e),
    }
}

impl GhExec for SystemGh {
    fn run(&self, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError> {
        // A missing folder would otherwise read as "gh is not installed".
        if !cwd.is_dir() {
            return Err(GitError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                cwd.display().to_string(),
            )));
        }
        let mut cmd = Command::new("gh");
        cmd.current_dir(cwd)
            .args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(spawn_error)?;

        // Drained on threads so a full pipe cannot block `gh`.
        let stdout = read_on_thread(child.stdout.take());
        let stderr = read_on_thread(child.stderr.take());
        if let (Some(mut pipe), Some(input)) = (child.stdin.take(), stdin) {
            let input = input.as_bytes().to_vec();
            thread::spawn(move || {
                let _ = pipe.write_all(&input);
            });
        }

        let deadline = Instant::now() + TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Timeout);
            }
            thread::sleep(POLL);
        };
        let left = || deadline.saturating_duration_since(Instant::now());
        let stdout = stdout.recv_timeout(left()).map_err(|_| GitError::Timeout)?;
        let stderr = stderr.recv_timeout(left()).map_err(|_| GitError::Timeout)?;
        Ok(GhOutput {
            status: status.code(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }
}

fn read_on_thread(pipe: Option<impl Read + Send + 'static>) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn pr_json(state: &str, draft: bool) -> String {
        format!(
            r#"{{"number":7,"url":"https://x/pull/7","state":"{state}","isDraft":{draft},"title":"T","baseRefName":"main","headRefName":"feat/x"}}"#
        )
    }

    fn cwd() -> &'static Path {
        Path::new(".")
    }

    #[test]
    fn pr_view_parses_open_and_draft() {
        let fake = Fake::new(vec![
            out(0, &pr_json("OPEN", false), ""),
            out(0, &pr_json("OPEN", true), ""),
            out(0, &pr_json("MERGED", false), ""),
        ]);
        let views: Vec<_> = (0..3)
            .map(|_| pr_view(&fake, cwd()).unwrap().unwrap())
            .collect();
        let states: Vec<_> = views.iter().map(|v| v.state.clone()).collect();
        assert_eq!(states, [PrState::Open, PrState::Draft, PrState::Merged]);
        assert_eq!(views[0].number, 7);
        assert_eq!(views[0].base, "main");
        assert_eq!(views[0].head, "feat/x");
        assert_eq!(
            fake.calls.borrow()[0].0,
            ["pr", "view", "--json", PR_FIELDS]
        );
    }

    #[test]
    fn pr_view_none_when_no_pr() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "no pull requests found for branch \"feat/x\"",
        )]);
        assert_eq!(pr_view(&fake, cwd()).unwrap(), None);
    }

    #[test]
    fn pr_create_passes_body_on_stdin_and_draft_flag() {
        let fake = Fake::new(vec![
            out(0, "https://x/pull/7\n", ""),
            out(0, &pr_json("OPEN", true), ""),
        ]);
        let draft = PrDraft {
            base: "main".into(),
            title: "T".into(),
            body: "B".into(),
            draft: true,
        };
        let pr = pr_create(&fake, cwd(), "feat/x", &draft).unwrap();
        assert_eq!(pr.state, PrState::Draft);
        let calls = fake.calls.borrow();
        assert_eq!(
            calls[0].0,
            [
                "pr",
                "create",
                "--base",
                "main",
                "--head",
                "feat/x",
                "--title",
                "T",
                "--body-file",
                "-",
                "--draft"
            ]
        );
        assert_eq!(calls[0].1.as_deref(), Some("B"));
    }

    #[test]
    fn pr_checks_reads_json_even_on_exit_8() {
        let json = r#"[{"name":"build","state":"PENDING","bucket":"pending","link":"https://x/1","workflow":"CI"},
            {"name":"lint","state":"SUCCESS","bucket":"pass","link":"","workflow":""}]"#;
        let fake = Fake::new(vec![out(8, json, "")]);
        let checks = pr_checks(&fake, cwd(), 7).unwrap();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].bucket, CheckBucket::Pending);
        assert_eq!(checks[0].workflow.as_deref(), Some("CI"));
        assert_eq!(checks[1].link, None);
        assert_eq!(checks[1].workflow, None);
        assert_eq!(
            fake.calls.borrow()[0].0,
            [
                "pr",
                "checks",
                "7",
                "--json",
                "name,state,bucket,link,workflow"
            ]
        );
    }

    #[test]
    fn pr_checks_empty_when_none_reported() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "no checks reported on the 'feat/x' branch",
        )]);
        assert!(pr_checks(&fake, cwd(), 7).unwrap().is_empty());
    }

    #[test]
    fn unknown_bucket_is_pending() {
        let fake = Fake::new(vec![out(0, r#"[{"name":"a","bucket":"weird"}]"#, "")]);
        assert_eq!(
            pr_checks(&fake, cwd(), 1).unwrap()[0].bucket,
            CheckBucket::Pending
        );
    }

    #[test]
    fn gh_missing_program() {
        let err = spawn_error(io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(err.code(), "gh_missing");
        assert_eq!(spawn_error(io::Error::other("x")).code(), "io");
    }

    #[test]
    fn gh_auth_from_stderr() {
        let fake = Fake::new(vec![out(4, "", "please run:  gh auth login")]);
        assert_eq!(pr_view(&fake, cwd()).unwrap_err().code(), "gh_auth");
    }

    #[test]
    fn not_github_from_stderr() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "none of the git remotes configured for this repository point to a known GitHub host",
        )]);
        assert_eq!(pr_view(&fake, cwd()).unwrap_err().code(), "not_github");
    }

    #[test]
    fn other_failure_is_gh_failed_with_stderr() {
        let fake = Fake::new(vec![out(1, "", "boom\n")]);
        let err = pr_view(&fake, cwd()).unwrap_err();
        assert_eq!(err.code(), "gh_failed");
        assert!(matches!(err, GitError::Gh(ref s) if s == "boom"));
    }

    #[test]
    fn parse_issue_ref_reads_numbers_and_urls() {
        for text in ["#12", "12", " #12 "] {
            assert_eq!(parse_issue_ref(text), Some((None, 12)), "{text}");
        }
        let url = Some((Some("o/r".to_owned()), 12));
        assert_eq!(parse_issue_ref("https://github.com/o/r/issues/12"), url);
        assert_eq!(parse_issue_ref("https://github.com/o/r/issues/12/"), url);
    }

    #[test]
    fn parse_issue_ref_refuses_the_rest() {
        for text in [
            "https://github.com/o/r/pull/12",
            "#0",
            "0",
            "99999999999999999999",
            "",
            "#",
            "#1x",
            "-3",
            "https://example.com/o/r/issues/12",
            "https://github.com/o/r/issues/12/files",
        ] {
            assert_eq!(parse_issue_ref(text), None, "{text}");
        }
    }
}
