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
/// What `run_failed_log` keeps of a log: the end, where a failure shows.
const LOG_CAP: usize = 64 * 1024;
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

/// A login `gh` holds, as one repo is bound to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct GhAccount {
    pub host: String,
    pub user: String,
}

/// One login `gh auth status` lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct GhLogin {
    pub host: String,
    pub user: String,
    /// The login `gh` uses when none is asked for.
    pub active: bool,
}

pub trait GhExec {
    fn run(&self, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError>;
}

/// Runs `gh` from `PATH`.
pub struct SystemGh;

/// A `gh` runner that can set variables for one call's process only.
pub trait GhEnv {
    fn run_env(
        &self,
        cwd: &Path,
        args: &[&str],
        stdin: Option<&str>,
        env: &[(&str, &str)],
    ) -> Result<GhOutput, GitError>;
}

/// Runs every call as one login `gh` holds: before each call it asks
/// `gh auth token --hostname <host> --user <user>` and runs the call with
/// that token in the call's own environment. The token is kept nowhere, and a
/// login `gh` no longer has fails with `gh_account_missing`, never falls back
/// to the default login.
pub struct TokenGh<'a, E: GhEnv = SystemGh> {
    pub inner: &'a E,
    pub account: GhAccount,
}

impl<E: GhEnv> GhExec for TokenGh<'_, E> {
    fn run(&self, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError> {
        let GhAccount { host, user } = &self.account;
        let asked = self.inner.run_env(
            cwd,
            &["auth", "token", "--hostname", host, "--user", user],
            None,
            &[],
        )?;
        let token = asked.stdout.trim();
        if asked.status != Some(0) || token.is_empty() {
            return Err(GitError::GhAccountMissing);
        }
        // `GH_TOKEN` is read for github.com only; other hosts have their own pair.
        let env: Vec<(&str, &str)> = if host == "github.com" {
            vec![("GH_TOKEN", token)]
        } else {
            vec![("GH_ENTERPRISE_TOKEN", token), ("GH_HOST", host)]
        };
        self.inner.run_env(cwd, args, stdin, &env)
    }
}

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
    if out.stderr.contains("missing required scopes") {
        GitError::GhScope(out.stderr.trim().to_owned())
    } else if out.stderr.contains("gh auth login") {
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

/// The run id in a check's link (`.../actions/runs/<id>/job/<job>`).
fn run_id(link: &str) -> Option<&str> {
    let (_, rest) = link.split_once("/actions/runs/")?;
    let id = rest.split(['/', '?', '#']).next()?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

/// The log of the failed jobs of the run behind a check's `link`, cut to its
/// last 64 KiB. `None` when the link names no run or `gh` has no log for it
/// (the run is still going, or its logs expired).
pub fn run_failed_log(gh: &dyn GhExec, cwd: &Path, link: &str) -> Result<Option<String>, GitError> {
    let Some(id) = run_id(link) else {
        return Ok(None);
    };
    let out = gh.run(cwd, &["run", "view", id, "--log-failed"], None)?;
    if out.status != Some(0) {
        if out.stderr.contains("gh auth login") || out.stderr.contains("none of the git remotes") {
            return Err(classify(&out));
        }
        return Ok(None);
    }
    let log = out.stdout.trim_end();
    if log.is_empty() {
        return Ok(None);
    }
    if log.len() <= LOG_CAP {
        return Ok(Some(log.to_owned()));
    }
    let mut start = log.len() - LOG_CAP;
    while !log.is_char_boundary(start) {
        start += 1;
    }
    Ok(Some(format!("[cut]\n{}", &log[start..])))
}

/// Every login `gh auth status` lists, in its order. A login whose token
/// failed is left out: no call could run as it. Empty when `gh` is signed in
/// nowhere, or when its text is not one this parser knows; only a missing
/// `gh` (or a timeout) is an error.
pub fn gh_logins(gh: &dyn GhExec) -> Result<Vec<GhLogin>, GitError> {
    let out = gh.run(Path::new("."), &["auth", "status"], None)?;
    // Newer gh writes the report to stdout, older ones to stderr.
    let text = format!("{}\n{}", out.stdout, out.stderr);
    let mut logins: Vec<GhLogin> = Vec::new();
    let mut marked = false;
    // Whether the last account line was a usable login.
    let mut last_ok = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix('\u{2713}')
            .map(str::trim_start)
            .and_then(|l| l.strip_prefix("Logged in to "))
        {
            // `<host> account <user> (<store>)`, or `<host> as <user> (<store>)` before gh 2.40.
            let mut words = rest.split_whitespace();
            let (Some(host), Some(sep), Some(user)) = (words.next(), words.next(), words.next())
            else {
                last_ok = false;
                continue;
            };
            last_ok = matches!(sep, "account" | "as");
            if last_ok {
                logins.push(GhLogin {
                    host: host.to_owned(),
                    user: user.to_owned(),
                    active: false,
                });
            }
        } else if line.contains("Failed to log in to ") {
            last_ok = false;
        } else if let Some(value) = line.strip_prefix("- Active account:") {
            marked = true;
            if last_ok && let Some(login) = logins.last_mut() {
                login.active = value.trim() == "true";
            }
        }
    }
    if !marked {
        // No marker: one login per host, and that one is the active one.
        for login in &mut logins {
            login.active = true;
        }
    }
    Ok(logins)
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

#[derive(Deserialize)]
struct RawNamed {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawLogin {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssue {
    number: u64,
    url: String,
    state: String,
    title: String,
    #[serde(default)]
    labels: Vec<RawNamed>,
    #[serde(default)]
    assignees: Vec<RawLogin>,
    author: Option<RawLogin>,
    #[serde(default)]
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    author: Option<RawLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Deserialize)]
struct RawIssueDetail {
    #[serde(flatten)]
    issue: RawIssue,
    #[serde(default)]
    body: String,
    #[serde(default)]
    comments: Vec<RawComment>,
}

fn login(l: Option<RawLogin>) -> Option<String> {
    l.map(|l| l.login).filter(|l| !l.is_empty())
}

impl From<RawIssue> for Issue {
    fn from(raw: RawIssue) -> Issue {
        Issue {
            number: raw.number,
            url: raw.url,
            state: if raw.state.eq_ignore_ascii_case("closed") {
                IssueState::Closed
            } else {
                IssueState::Open
            },
            title: raw.title,
            labels: raw.labels.into_iter().map(|l| l.name).collect(),
            assignees: raw.assignees.into_iter().map(|a| a.login).collect(),
            author: login(raw.author),
            updated_at: raw.updated_at,
        }
    }
}

/// Cuts to `ISSUE_BODY_MAX` chars.
fn cut_body(mut text: String) -> String {
    if let Some((i, _)) = text.char_indices().nth(ISSUE_BODY_MAX) {
        text.truncate(i);
    }
    text
}

const DEFAULT_ISSUE_LIMIT: u32 = 100;
const SEARCH_MAX: usize = 256;

pub fn issue_list(gh: &dyn GhExec, cwd: &Path, q: &IssueQuery) -> Result<Vec<Issue>, GitError> {
    let limit = q
        .limit
        .unwrap_or(DEFAULT_ISSUE_LIMIT)
        .clamp(1, ISSUE_LIMIT_MAX)
        .to_string();
    let search: Option<String> = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(SEARCH_MAX).collect());
    let mut args = vec!["issue", "list", "--json", ISSUE_FIELDS, "--limit", &limit];
    if q.state == Some(IssueState::Closed) {
        args.extend(["--state", "closed"]);
    }
    if q.assignee_me {
        args.extend(["--assignee", "@me"]);
    }
    if let Some(s) = &search {
        args.extend(["--search", s]);
    }
    let out = ok(gh.run(cwd, &args, None)?)?;
    let raw: Vec<RawIssue> = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(raw.into_iter().map(Issue::from).collect())
}

pub fn issue_view(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<IssueDetail, GitError> {
    let number = number.to_string();
    let fields = format!("{ISSUE_FIELDS},body,comments");
    let out = gh.run(cwd, &["issue", "view", &number, "--json", &fields], None)?;
    if out.status != Some(0) {
        if out.stderr.contains("Could not resolve to an issue") {
            return Err(GitError::IssueNotFound);
        }
        return Err(classify(&out));
    }
    let raw: RawIssueDetail = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(IssueDetail {
        issue: raw.issue.into(),
        body: cut_body(raw.body),
        comments: raw
            .comments
            .into_iter()
            .map(|c| IssueComment {
                author: login(c.author),
                body: cut_body(c.body),
                created_at: c.created_at,
            })
            .collect(),
    })
}

/// `owner/repo` of the repo `cwd` belongs to, as GitHub names it.
pub fn repo_name(gh: &dyn GhExec, cwd: &Path) -> Result<String, GitError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        name_with_owner: String,
    }
    let out = ok(gh.run(cwd, &["repo", "view", "--json", "nameWithOwner"], None)?)?;
    let raw: Raw = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(raw.name_with_owner)
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

/// Opens the issue in the browser through `gh`.
pub fn issue_open_web(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<(), GitError> {
    let number = number.to_string();
    ok(gh.run(cwd, &["issue", "view", &number, "--web"], None)?)?;
    Ok(())
}

const PR_LIST_FIELDS: &str =
    "number,url,state,isDraft,title,baseRefName,headRefName,author,updatedAt,isCrossRepository";

/// A row of `gh pr list` or `gh pr view <n>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub url: String,
    pub state: PrState,
    pub title: String,
    pub base: String,
    pub head: String,
    pub author: Option<String>,
    /// RFC 3339 as `gh` prints it.
    pub updated_at: String,
    /// The head lives in another repo (`isCrossRepository`).
    pub fork: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PrFilter {
    Open,
    Closed,
    Merged,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrQuery {
    /// `None` reads as open.
    pub state: Option<PrFilter>,
    /// `--author @me`.
    pub mine: bool,
    /// `review-requested:@me`, joined with `search`.
    pub needs_review: bool,
    /// At most 256 chars.
    pub search: Option<String>,
    /// Default 100, capped at `ISSUE_LIMIT_MAX`.
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrSummary {
    number: u64,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    title: String,
    base_ref_name: String,
    head_ref_name: String,
    author: Option<RawLogin>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    is_cross_repository: bool,
}

impl From<RawPrSummary> for PrSummary {
    fn from(raw: RawPrSummary) -> PrSummary {
        let state = match raw.state.as_str() {
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ if raw.is_draft => PrState::Draft,
            _ => PrState::Open,
        };
        PrSummary {
            number: raw.number,
            url: raw.url,
            state,
            title: raw.title,
            base: raw.base_ref_name,
            head: raw.head_ref_name,
            author: login(raw.author),
            updated_at: raw.updated_at,
            fork: raw.is_cross_repository,
        }
    }
}

pub fn pr_list(gh: &dyn GhExec, cwd: &Path, q: &PrQuery) -> Result<Vec<PrSummary>, GitError> {
    let limit = q
        .limit
        .unwrap_or(DEFAULT_ISSUE_LIMIT)
        .clamp(1, ISSUE_LIMIT_MAX)
        .to_string();
    let mut search: String = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(SEARCH_MAX).collect())
        .unwrap_or_default();
    if q.needs_review {
        search = format!("review-requested:@me {search}").trim().to_owned();
    }
    let mut args = vec!["pr", "list", "--json", PR_LIST_FIELDS, "--limit", &limit];
    match q.state {
        Some(PrFilter::Closed) => args.extend(["--state", "closed"]),
        Some(PrFilter::Merged) => args.extend(["--state", "merged"]),
        Some(PrFilter::All) => args.extend(["--state", "all"]),
        Some(PrFilter::Open) | None => {}
    }
    if q.mine {
        args.extend(["--author", "@me"]);
    }
    if !search.is_empty() {
        args.extend(["--search", &search]);
    }
    let out = ok(gh.run(cwd, &args, None)?)?;
    let raw: Vec<RawPrSummary> = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(raw.into_iter().map(PrSummary::from).collect())
}

pub fn pr_get(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<PrSummary, GitError> {
    let number = number.to_string();
    let out = gh.run(
        cwd,
        &["pr", "view", &number, "--json", PR_LIST_FIELDS],
        None,
    )?;
    if out.status != Some(0) {
        if out.stderr.contains("Could not resolve to a PullRequest") {
            return Err(GitError::PrNotFound);
        }
        return Err(classify(&out));
    }
    let raw: RawPrSummary = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(raw.into())
}

/// Opens pull request `number` in the browser through `gh`.
pub fn pr_open_number(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<(), GitError> {
    let number = number.to_string();
    ok(gh.run(cwd, &["pr", "view", &number, "--web"], None)?)?;
    Ok(())
}

/// What `issue_create` sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueDraft {
    pub title: String,
    pub body: String,
}

/// A GitHub Project of an owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub title: String,
    pub url: String,
    pub closed: bool,
    /// `items.totalCount`.
    pub items: u32,
}

const TITLE_MAX: usize = 256;

/// Creates the issue (body on stdin) and reads it back from the URL `gh` prints.
pub fn issue_create(gh: &dyn GhExec, cwd: &Path, draft: &IssueDraft) -> Result<Issue, GitError> {
    let title = draft.title.trim();
    if title.is_empty()
        || title.chars().count() > TITLE_MAX
        || draft.body.chars().count() > ISSUE_BODY_MAX
    {
        return Err(GitError::BadDraft);
    }
    let out = ok(gh.run(
        cwd,
        &["issue", "create", "--title", title, "--body-file", "-"],
        Some(&draft.body),
    )?)?;
    let number = out
        .stdout
        .lines()
        .rev()
        .map(str::trim)
        .find_map(|l| parse_issue_ref(l).map(|(_, n)| n))
        .ok_or_else(|| GitError::Gh("gh printed no issue URL".into()))?;
    let n = number.to_string();
    let out = ok(gh.run(cwd, &["issue", "view", &n, "--json", ISSUE_FIELDS], None)?)?;
    let raw: RawIssue = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(raw.into())
}

fn owner_ok(owner: &str) -> Result<(), GitError> {
    if owner.is_empty() || owner.starts_with('-') || owner.contains('/') {
        return Err(GitError::Gh(format!("bad owner: {owner}")));
    }
    Ok(())
}

/// The GitHub Projects of `owner`, open and closed.
pub fn project_list(
    gh: &dyn GhExec,
    cwd: &Path,
    owner: &str,
) -> Result<Vec<ProjectSummary>, GitError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Items {
        #[serde(default)]
        total_count: u32,
    }
    #[derive(Deserialize)]
    struct Raw {
        number: u64,
        #[serde(default)]
        title: String,
        #[serde(default)]
        url: String,
        #[serde(default)]
        closed: bool,
        items: Option<Items>,
    }
    #[derive(Deserialize)]
    struct Wrap {
        #[serde(default)]
        projects: Vec<Raw>,
    }
    owner_ok(owner)?;
    let out = ok(gh.run(
        cwd,
        &[
            "project", "list", "--owner", owner, "--closed", "--format", "json", "--limit", "100",
        ],
        None,
    )?)?;
    let wrap: Wrap = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(wrap
        .projects
        .into_iter()
        .map(|p| ProjectSummary {
            number: p.number,
            title: p.title,
            url: p.url,
            closed: p.closed,
            items: p.items.map_or(0, |i| i.total_count),
        })
        .collect())
}

/// Opens a project of `owner` in the browser through `gh`.
pub fn project_open(gh: &dyn GhExec, cwd: &Path, owner: &str, number: u64) -> Result<(), GitError> {
    owner_ok(owner)?;
    let n = number.to_string();
    ok(gh.run(
        cwd,
        &["project", "view", &n, "--owner", owner, "--web"],
        None,
    )?)?;
    Ok(())
}

/// "https://github.com/<owner>/<repo>/pull/12" gives (`owner/repo`, 12).
pub fn parse_pr_ref(text: &str) -> Option<(Option<String>, u64)> {
    let rest = text.trim().strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    match parts.as_slice() {
        [owner, repo, "pull", n] if !owner.is_empty() && !repo.is_empty() => {
            let digits = !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit());
            n.parse::<u64>()
                .ok()
                .filter(|n| digits && *n > 0)
                .map(|n| (Some(format!("{owner}/{repo}")), n))
        }
        _ => None,
    }
}

fn spawn_error(e: io::Error) -> GitError {
    match e.kind() {
        io::ErrorKind::NotFound => GitError::GhMissing,
        _ => GitError::Io(e),
    }
}

impl GhExec for SystemGh {
    fn run(&self, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError> {
        self.run_env(cwd, args, stdin, &[])
    }
}

impl GhEnv for SystemGh {
    fn run_env(
        &self,
        cwd: &Path,
        args: &[&str],
        stdin: Option<&str>,
        env: &[(&str, &str)],
    ) -> Result<GhOutput, GitError> {
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
            .envs(env.iter().copied())
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

    const LIST_FIXTURE: &str = include_str!("../fixtures/issue_list.json");
    const VIEW_FIXTURE: &str = include_str!("../fixtures/issue_view.json");

    fn args_of(fake: &Fake) -> Vec<String> {
        fake.calls.borrow()[0].0.clone()
    }

    fn raw_pr(n: u64, state: &str, draft: bool, fork: bool) -> String {
        format!(
            r#"{{"number":{n},"url":"https://github.com/o/r/pull/{n}","state":"{state}","isDraft":{draft},"title":"T{n}","baseRefName":"main","headRefName":"feat/{n}","author":{{"login":"hubot"}},"updatedAt":"2026-11-03T09:15:00Z","isCrossRepository":{fork}}}"#
        )
    }

    #[test]
    fn pr_list_default_args_and_mapping() {
        let body = format!(
            "[{},{},{}]",
            raw_pr(1, "OPEN", false, false),
            raw_pr(2, "OPEN", true, true),
            raw_pr(3, "MERGED", false, false)
        );
        let fake = Fake::new(vec![out(0, &body, "")]);
        let prs = pr_list(&fake, cwd(), &PrQuery::default()).unwrap();
        assert_eq!(
            args_of(&fake),
            ["pr", "list", "--json", PR_LIST_FIELDS, "--limit", "100"]
        );
        assert_eq!(prs[0].state, PrState::Open);
        assert_eq!(prs[0].author.as_deref(), Some("hubot"));
        assert!(!prs[0].fork);
        assert_eq!(prs[1].state, PrState::Draft);
        assert!(prs[1].fork);
        assert_eq!(prs[2].state, PrState::Merged);
        assert_eq!(prs[2].head, "feat/3");
    }

    #[test]
    fn pr_list_args_follow_the_query() {
        let fake = Fake::new(vec![out(0, "[]", ""), out(0, "[]", ""), out(0, "[]", "")]);
        let q = PrQuery {
            state: Some(PrFilter::Merged),
            mine: true,
            needs_review: true,
            search: Some("  footer ".into()),
            limit: Some(9999),
        };
        pr_list(&fake, cwd(), &q).unwrap();
        assert_eq!(
            args_of(&fake)[4..],
            [
                "--limit",
                "200",
                "--state",
                "merged",
                "--author",
                "@me",
                "--search",
                "review-requested:@me footer"
            ]
        );
        let q = PrQuery {
            needs_review: true,
            ..PrQuery::default()
        };
        pr_list(&fake, cwd(), &q).unwrap();
        assert_eq!(
            fake.calls.borrow()[1].0.last().unwrap(),
            "review-requested:@me"
        );
        let q = PrQuery {
            state: Some(PrFilter::All),
            ..PrQuery::default()
        };
        pr_list(&fake, cwd(), &q).unwrap();
        assert!(fake.calls.borrow()[2].0.contains(&"all".to_owned()));
    }

    #[test]
    fn pr_get_maps_fork_and_not_found() {
        let fake = Fake::new(vec![
            out(0, &raw_pr(13, "OPEN", false, true), ""),
            out(
                1,
                "",
                "GraphQL: Could not resolve to a PullRequest with the number of 99.",
            ),
        ]);
        let pr = pr_get(&fake, cwd(), 13).unwrap();
        assert!(pr.fork);
        assert_eq!(
            fake.calls.borrow()[0].0,
            ["pr", "view", "13", "--json", PR_LIST_FIELDS]
        );
        let err = pr_get(&fake, cwd(), 99).unwrap_err();
        assert_eq!(err.code(), "pr_not_found");
    }

    #[test]
    fn pr_get_keeps_a_network_failure_as_gh_error() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "error connecting: Could not resolve host: api.github.com",
        )]);
        let err = pr_get(&fake, cwd(), 5).unwrap_err();
        assert!(matches!(err, GitError::Gh(_)), "{err:?}");
    }

    #[test]
    fn pr_open_number_runs_view_web() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_open_number(&fake, cwd(), 7).unwrap();
        assert_eq!(args_of(&fake), ["pr", "view", "7", "--web"]);
    }

    #[test]
    fn issue_create_sends_body_on_stdin_and_reads_back() {
        let view = r#"{"number":42,"url":"https://github.com/o/r/issues/42","state":"OPEN","title":"New","labels":[],"assignees":[],"author":{"login":"me"},"updatedAt":"2026-11-04T00:00:00Z"}"#;
        let fake = Fake::new(vec![
            out(0, "https://github.com/o/r/issues/42\n", ""),
            out(0, view, ""),
        ]);
        let draft = IssueDraft {
            title: "  New ".into(),
            body: "line\nTwo".into(),
        };
        let issue = issue_create(&fake, cwd(), &draft).unwrap();
        assert_eq!(issue.number, 42);
        let calls = fake.calls.borrow();
        assert_eq!(
            calls[0].0,
            ["issue", "create", "--title", "New", "--body-file", "-"]
        );
        assert_eq!(calls[0].1.as_deref(), Some("line\nTwo"));
        assert_eq!(calls[1].0, ["issue", "view", "42", "--json", ISSUE_FIELDS]);
    }

    #[test]
    fn issue_create_refuses_bad_drafts() {
        let fake = Fake::new(vec![]);
        for title in ["", "   ", &"x".repeat(257)] {
            let d = IssueDraft {
                title: title.to_owned(),
                body: String::new(),
            };
            let err = issue_create(&fake, cwd(), &d).unwrap_err();
            assert_eq!(err.code(), "bad_draft");
        }
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn project_list_parses_items_and_passes_owner() {
        let json = r#"{"projects":[{"number":1,"title":"Roadmap","url":"https://github.com/orgs/acme/projects/1","closed":false,"items":{"totalCount":12}},{"number":2,"title":"Old","url":"https://github.com/orgs/acme/projects/2","closed":true,"items":{"totalCount":0}}],"totalCount":2}"#;
        let fake = Fake::new(vec![out(0, json, "")]);
        let list = project_list(&fake, cwd(), "acme").unwrap();
        assert_eq!(
            args_of(&fake),
            [
                "project", "list", "--owner", "acme", "--closed", "--format", "json", "--limit",
                "100"
            ]
        );
        assert_eq!(list.len(), 2);
        assert_eq!(
            (list[0].number, list[0].items, list[0].closed),
            (1, 12, false)
        );
        assert!(list[1].closed);
    }

    #[test]
    fn project_list_maps_a_missing_scope() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "error: your authentication token is missing required scopes [read:project]",
        )]);
        let err = project_list(&fake, cwd(), "acme").unwrap_err();
        assert_eq!(err.code(), "gh_scope");
    }

    #[test]
    fn project_open_runs_view_web_and_refuses_odd_owners() {
        let fake = Fake::new(vec![out(0, "", "")]);
        project_open(&fake, cwd(), "acme", 3).unwrap();
        assert_eq!(
            args_of(&fake),
            ["project", "view", "3", "--owner", "acme", "--web"]
        );
        assert!(project_open(&fake, cwd(), "--x", 3).is_err());
    }

    #[test]
    fn parse_pr_ref_reads_pull_urls_only() {
        let url = Some((Some("o/r".to_owned()), 12));
        assert_eq!(parse_pr_ref("https://github.com/o/r/pull/12"), url);
        assert_eq!(parse_pr_ref(" https://github.com/o/r/pull/12/ "), url);
        for text in [
            "#12",
            "12",
            "https://github.com/o/r/issues/12",
            "https://github.com/o/r/pull/0",
            "https://github.com/o/r/pull/12/files",
            "https://example.com/o/r/pull/12",
        ] {
            assert_eq!(parse_pr_ref(text), None, "{text}");
        }
    }

    #[test]
    fn issue_list_default_args_and_fixture() {
        let fake = Fake::new(vec![out(0, LIST_FIXTURE, "")]);
        let issues = issue_list(&fake, cwd(), &IssueQuery::default()).unwrap();
        assert_eq!(
            args_of(&fake),
            ["issue", "list", "--json", ISSUE_FIELDS, "--limit", "100"]
        );
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].number, 123);
        assert_eq!(issues[0].state, IssueState::Open);
        assert_eq!(issues[0].labels, ["bug", "ui"]);
        assert_eq!(issues[0].assignees, ["octocat"]);
        assert_eq!(issues[0].author.as_deref(), Some("hubot"));
        assert_eq!(issues[0].updated_at, "2026-11-03T09:15:00Z");
        assert_eq!(issues[1].state, IssueState::Closed);
        assert!(issues[1].labels.is_empty() && issues[1].assignees.is_empty());
    }

    #[test]
    fn issue_list_args_follow_the_query() {
        let fake = Fake::new(vec![out(0, "[]", "")]);
        let q = IssueQuery {
            state: Some(IssueState::Closed),
            assignee_me: true,
            search: Some("  footer  ".into()),
            limit: Some(9999),
        };
        issue_list(&fake, cwd(), &q).unwrap();
        assert_eq!(
            args_of(&fake),
            [
                "issue",
                "list",
                "--json",
                ISSUE_FIELDS,
                "--limit",
                "200",
                "--state",
                "closed",
                "--assignee",
                "@me",
                "--search",
                "footer"
            ]
        );
    }

    #[test]
    fn issue_list_cuts_search_and_ignores_blank() {
        let fake = Fake::new(vec![out(0, "[]", ""), out(0, "[]", "")]);
        let long = IssueQuery {
            search: Some("é".repeat(300)),
            limit: Some(0),
            ..IssueQuery::default()
        };
        issue_list(&fake, cwd(), &long).unwrap();
        let a = args_of(&fake);
        assert_eq!(a[5], "1");
        assert_eq!(a.last().unwrap().chars().count(), 256);
        let blank = IssueQuery {
            search: Some("   ".into()),
            ..IssueQuery::default()
        };
        issue_list(&fake, cwd(), &blank).unwrap();
        assert!(!fake.calls.borrow()[1].0.contains(&"--search".to_owned()));
    }

    #[test]
    fn issue_list_failure_is_classified() {
        let fake = Fake::new(vec![out(4, "", "run: gh auth login")]);
        let err = issue_list(&fake, cwd(), &IssueQuery::default()).unwrap_err();
        assert_eq!(err.code(), "gh_auth");
        let fake = Fake::new(vec![out(0, "not json", "")]);
        let err = issue_list(&fake, cwd(), &IssueQuery::default()).unwrap_err();
        assert_eq!(err.code(), "gh_failed");
    }

    #[test]
    fn issue_view_reads_the_fixture() {
        let fake = Fake::new(vec![out(0, VIEW_FIXTURE, "")]);
        let d = issue_view(&fake, cwd(), 123).unwrap();
        assert_eq!(
            args_of(&fake),
            [
                "issue",
                "view",
                "123",
                "--json",
                "number,url,state,title,labels,assignees,author,updatedAt,body,comments"
            ]
        );
        assert_eq!(d.issue.number, 123);
        assert!(d.body.starts_with("The meter wraps"));
        assert_eq!(d.comments.len(), 1);
        assert_eq!(d.comments[0].author.as_deref(), Some("octocat"));
        assert_eq!(d.comments[0].body, "Looking at it.");
        assert_eq!(d.comments[0].created_at, "2026-11-03T10:00:00Z");
    }

    #[test]
    fn issue_view_cuts_long_bodies_by_chars() {
        let body = "é".repeat(ISSUE_BODY_MAX + 10);
        let json = format!(
            r#"{{"number":1,"url":"u","state":"OPEN","title":"t","labels":[],"assignees":[],"author":null,"updatedAt":"x","body":"{body}","comments":[{{"author":null,"body":"{body}","createdAt":"y"}}]}}"#
        );
        let fake = Fake::new(vec![out(0, &json, "")]);
        let d = issue_view(&fake, cwd(), 1).unwrap();
        assert_eq!(d.body.chars().count(), ISSUE_BODY_MAX);
        assert_eq!(d.comments[0].body.chars().count(), ISSUE_BODY_MAX);
        assert_eq!(d.comments[0].author, None);
    }

    #[test]
    fn issue_view_not_found() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "GraphQL: Could not resolve to an issue or pull request with the number of 99. (repository.issue)",
        )]);
        assert_eq!(
            issue_view(&fake, cwd(), 99).unwrap_err().code(),
            "issue_not_found"
        );
    }

    #[test]
    fn repo_name_reads_name_with_owner() {
        let fake = Fake::new(vec![out(0, r#"{"nameWithOwner":"acme/app"}"#, "")]);
        assert_eq!(repo_name(&fake, cwd()).unwrap(), "acme/app");
        assert_eq!(args_of(&fake), ["repo", "view", "--json", "nameWithOwner"]);
    }

    #[test]
    fn issue_open_web_runs_view_web() {
        let fake = Fake::new(vec![out(0, "", "")]);
        issue_open_web(&fake, cwd(), 12).unwrap();
        assert_eq!(args_of(&fake), ["issue", "view", "12", "--web"]);
        let fake = Fake::new(vec![out(1, "", "boom")]);
        assert_eq!(
            issue_open_web(&fake, cwd(), 12).unwrap_err().code(),
            "gh_failed"
        );
    }

    #[test]
    fn run_failed_log_asks_for_the_run_of_the_link() {
        let fake = Fake::new(vec![out(0, "build\tstep\terror: boom\n", "")]);
        let link = "https://github.com/o/r/actions/runs/12345/job/678";
        let log = run_failed_log(&fake, cwd(), link).unwrap();
        assert_eq!(log.as_deref(), Some("build\tstep\terror: boom"));
        assert_eq!(
            fake.calls.borrow()[0].0,
            ["run", "view", "12345", "--log-failed"]
        );
    }

    #[test]
    fn run_failed_log_keeps_the_end_of_a_long_log() {
        let long = format!("{}END\n", "é".repeat(LOG_CAP));
        let fake = Fake::new(vec![out(0, &long, "")]);
        let link = "https://github.com/o/r/actions/runs/1";
        let log = run_failed_log(&fake, cwd(), link).unwrap().unwrap();
        assert!(log.starts_with("[cut]\n") && log.ends_with("END"));
        assert!(log.len() <= LOG_CAP + 8, "{}", log.len());
    }

    #[test]
    fn run_failed_log_is_none_without_a_run_or_a_log() {
        // No call is made for a link that names no run.
        let fake = Fake::new(vec![]);
        for link in [
            "",
            "https://example.com/x",
            "https://github.com/o/r/actions/runs/x",
        ] {
            assert_eq!(run_failed_log(&fake, cwd(), link).unwrap(), None, "{link}");
        }
        assert!(fake.calls.borrow().is_empty());
        // A run still going, or with expired logs.
        let fake = Fake::new(vec![
            out(
                1,
                "",
                "run 9 is still in progress; logs will be available when it is complete",
            ),
            out(0, "  \n", ""),
        ]);
        let link = "https://github.com/o/r/actions/runs/9";
        assert_eq!(run_failed_log(&fake, cwd(), link).unwrap(), None);
        assert_eq!(run_failed_log(&fake, cwd(), link).unwrap(), None);
    }

    #[test]
    fn run_failed_log_reports_a_login_problem() {
        let fake = Fake::new(vec![out(
            4,
            "",
            "To get started with GitHub CLI, please run:  gh auth login",
        )]);
        let link = "https://github.com/o/r/actions/runs/9";
        assert!(matches!(
            run_failed_log(&fake, cwd(), link),
            Err(GitError::GhAuth)
        ));
    }

    // Recorded from `gh auth status`; the exact text differs between gh versions.
    const STATUS_ONE: &str = "github.com
  \u{2713} Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'
";
    const STATUS_TWO: &str = "github.com
  \u{2713} Logged in to github.com account work-me (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************

  \u{2713} Logged in to github.com account me (keyring)
  - Active account: false
  - Git operations protocol: ssh
  - Token: gho_************************************

git.corp.example
  \u{2713} Logged in to git.corp.example account corp-me (keyring)
  - Active account: true
";
    // Before gh 2.40: one login per host, no active marker, on stderr.
    const STATUS_OLD: &str = "github.com
  \u{2713} Logged in to github.com as octocat (oauth_token)
  \u{2713} Git operations for github.com configured to use https protocol.
  \u{2713} Token: *******************
";
    const STATUS_BROKEN: &str = "github.com
  X Failed to log in to github.com account stale (keyring)
  - Active account: true
  - The token in keyring is invalid.

  \u{2713} Logged in to github.com account fine (keyring)
  - Active account: false
";

    fn login(host: &str, user: &str, active: bool) -> GhLogin {
        GhLogin {
            host: host.into(),
            user: user.into(),
            active,
        }
    }

    #[test]
    fn gh_logins_reads_one_host_one_user() {
        let fake = Fake::new(vec![out(0, STATUS_ONE, "")]);
        assert_eq!(
            gh_logins(&fake).unwrap(),
            vec![login("github.com", "octocat", true)]
        );
        assert_eq!(fake.calls.borrow()[0].0, ["auth", "status"]);
    }

    #[test]
    fn gh_logins_reads_every_host_and_user_with_the_active_marker() {
        let fake = Fake::new(vec![out(0, STATUS_TWO, "")]);
        assert_eq!(
            gh_logins(&fake).unwrap(),
            vec![
                login("github.com", "work-me", true),
                login("github.com", "me", false),
                login("git.corp.example", "corp-me", true),
            ]
        );
    }

    #[test]
    fn gh_logins_reads_the_old_format_from_stderr() {
        let fake = Fake::new(vec![out(0, "", STATUS_OLD)]);
        assert_eq!(
            gh_logins(&fake).unwrap(),
            vec![login("github.com", "octocat", true)]
        );
    }

    #[test]
    fn gh_logins_skips_a_login_whose_token_failed() {
        let fake = Fake::new(vec![out(1, STATUS_BROKEN, "")]);
        assert_eq!(
            gh_logins(&fake).unwrap(),
            vec![login("github.com", "fine", false)]
        );
    }

    #[test]
    fn gh_logins_is_empty_when_not_logged_in_or_unreadable() {
        let fake = Fake::new(vec![
            out(
                1,
                "",
                "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
            ),
            out(0, "something new and unexpected\n", ""),
        ]);
        assert_eq!(gh_logins(&fake).unwrap(), vec![]);
        assert_eq!(gh_logins(&fake).unwrap(), vec![]);
    }

    #[test]
    fn gh_logins_passes_on_a_missing_gh() {
        struct Gone;
        impl GhExec for Gone {
            fn run(&self, _: &Path, _: &[&str], _: Option<&str>) -> Result<GhOutput, GitError> {
                Err(GitError::GhMissing)
            }
        }
        assert!(matches!(gh_logins(&Gone), Err(GitError::GhMissing)));
    }

    type EnvCall = (Vec<String>, Vec<(String, String)>);

    // A fake that also records the environment each call was given.
    struct EnvFake {
        calls: RefCell<Vec<EnvCall>>,
        script: RefCell<VecDeque<GhOutput>>,
    }

    impl EnvFake {
        fn new(script: Vec<GhOutput>) -> EnvFake {
            EnvFake {
                calls: RefCell::new(Vec::new()),
                script: RefCell::new(script.into()),
            }
        }
    }

    impl GhEnv for EnvFake {
        fn run_env(
            &self,
            _: &Path,
            args: &[&str],
            _: Option<&str>,
            env: &[(&str, &str)],
        ) -> Result<GhOutput, GitError> {
            self.calls.borrow_mut().push((
                args.iter().map(|s| s.to_string()).collect(),
                env.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
            Ok(self.script.borrow_mut().pop_front().expect("scripted"))
        }
    }

    fn account(host: &str, user: &str) -> GhAccount {
        GhAccount {
            host: host.into(),
            user: user.into(),
        }
    }

    #[test]
    fn token_gh_asks_for_the_token_then_runs_with_it() {
        let inner = EnvFake::new(vec![out(0, "gho_secret\n", ""), out(0, "[]", "")]);
        let gh = TokenGh {
            inner: &inner,
            account: account("github.com", "u"),
        };
        assert_eq!(pr_checks(&gh, cwd(), 7).unwrap(), vec![]);
        let calls = inner.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].0,
            ["auth", "token", "--hostname", "github.com", "--user", "u"]
        );
        assert!(calls[0].1.is_empty(), "the token is asked for without one");
        assert_eq!(calls[1].0[..2], ["pr", "checks"]);
        assert_eq!(
            calls[1].1,
            [("GH_TOKEN".to_owned(), "gho_secret".to_owned())]
        );
    }

    #[test]
    fn token_gh_asks_for_a_token_on_every_call() {
        let inner = EnvFake::new(vec![
            out(0, "t1\n", ""),
            out(0, "[]", ""),
            out(0, "t2\n", ""),
            out(0, "[]", ""),
        ]);
        let gh = TokenGh {
            inner: &inner,
            account: account("github.com", "u"),
        };
        pr_checks(&gh, cwd(), 1).unwrap();
        pr_checks(&gh, cwd(), 1).unwrap();
        let calls = inner.calls.borrow();
        assert_eq!(calls[1].1[0].1, "t1");
        assert_eq!(calls[3].1[0].1, "t2");
    }

    #[test]
    fn token_gh_uses_the_enterprise_variables_off_github_com() {
        let inner = EnvFake::new(vec![out(0, "tok\n", ""), out(0, "[]", "")]);
        let gh = TokenGh {
            inner: &inner,
            account: account("git.corp.example", "u"),
        };
        pr_checks(&gh, cwd(), 1).unwrap();
        assert_eq!(
            inner.calls.borrow()[1].1,
            [
                ("GH_ENTERPRISE_TOKEN".to_owned(), "tok".to_owned()),
                ("GH_HOST".to_owned(), "git.corp.example".to_owned()),
            ]
        );
    }

    #[test]
    fn token_gh_refuses_when_the_login_is_gone() {
        for token_out in [
            out(1, "", "no oauth token found for github.com account u"),
            out(0, "  \n", ""),
        ] {
            let inner = EnvFake::new(vec![token_out]);
            let gh = TokenGh {
                inner: &inner,
                account: account("github.com", "u"),
            };
            let err = pr_checks(&gh, cwd(), 1).unwrap_err();
            assert_eq!(err.code(), "gh_account_missing");
            // The call itself never ran, with this or another login.
            assert_eq!(inner.calls.borrow().len(), 1);
        }
    }

    #[test]
    fn token_gh_passes_on_a_missing_gh_and_never_prints_the_token() {
        struct Gone;
        impl GhEnv for Gone {
            fn run_env(
                &self,
                _: &Path,
                _: &[&str],
                _: Option<&str>,
                _: &[(&str, &str)],
            ) -> Result<GhOutput, GitError> {
                Err(GitError::GhMissing)
            }
        }
        let gh = TokenGh {
            inner: &Gone,
            account: account("github.com", "u"),
        };
        assert!(matches!(pr_checks(&gh, cwd(), 1), Err(GitError::GhMissing)));
        // A failed call's error carries gh's stderr, not the token.
        let inner = EnvFake::new(vec![out(0, "gho_secret\n", ""), out(1, "", "boom")]);
        let gh = TokenGh {
            inner: &inner,
            account: account("github.com", "u"),
        };
        let err = pr_checks(&gh, cwd(), 1).unwrap_err();
        assert!(!format!("{err} {err:?}").contains("gho_secret"));
    }
}
