//! The pull request panel through `gh`: one read of the PR of the current
//! branch (conversation, reviews, files, auto-merge), a conversation comment,
//! and auto-merge on or off. Every call goes through `GhExec`, so a test runs
//! no `gh`. A comment body goes on stdin, never in argv.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{GhExec, PrState, classify, ok, parse_error};
use crate::gh_review::{COMMENT_BODY_MAX, MergeMethod};

const DETAIL_FIELDS: &str = "number,url,state,isDraft,title,body,baseRefName,headRefName,\
author,reviewDecision,mergeable,mergeStateStatus,comments,reviews,reviewRequests,files,\
autoMergeRequest";

/// Chars kept of the PR body and of one comment; the rest is cut.
pub const PR_TEXT_MAX: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

/// `mergeStateStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum MergeState {
    Clean,
    Dirty,
    Blocked,
    Behind,
    Unstable,
    HasHooks,
    Draft,
    Unknown,
}

/// What one reviewer last said, or `Requested` while a review is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ReviewerState {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
    Requested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub login: String,
    pub state: ReviewerState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PrEntryKind {
    Comment,
    Review,
}

/// One comment or review of the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrEntry {
    pub kind: PrEntryKind,
    /// `ghost` when GitHub has no author any more.
    pub author: String,
    pub body: String,
    /// `submittedAt` for a review. RFC 3339 as `gh` prints it.
    pub at: String,
    pub url: Option<String>,
    /// The verdict of a review.
    pub review: Option<ReviewerState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub additions: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub deletions: u64,
}

/// Auto-merge as it is armed on the PR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrAutoMerge {
    pub method: MergeMethod,
    pub enabled_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    pub url: String,
    pub state: PrState,
    pub title: String,
    pub body: String,
    pub author: Option<String>,
    pub base: String,
    pub head: String,
    pub review_decision: Option<ReviewDecision>,
    pub mergeable: Mergeable,
    pub merge_state: MergeState,
    pub reviewers: Vec<PrReviewer>,
    /// Comments and reviews, oldest first.
    pub entries: Vec<PrEntry>,
    pub files: Vec<PrFile>,
    pub auto_merge: Option<PrAutoMerge>,
}

#[derive(Deserialize)]
struct RawLogin {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    author: Option<RawLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    submitted_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
}

/// A review request is a user (`login`) or a team (`name`).
#[derive(Deserialize)]
struct RawRequest {
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawFile {
    path: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuto {
    #[serde(default)]
    merge_method: String,
    enabled_by: Option<RawLogin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDetail {
    number: u64,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    title: String,
    #[serde(default)]
    body: String,
    author: Option<RawLogin>,
    base_ref_name: String,
    head_ref_name: String,
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    mergeable: String,
    #[serde(default)]
    merge_state_status: String,
    #[serde(default)]
    comments: Vec<RawEntry>,
    #[serde(default)]
    reviews: Vec<RawEntry>,
    #[serde(default)]
    review_requests: Vec<RawRequest>,
    #[serde(default)]
    files: Vec<RawFile>,
    #[serde(default)]
    auto_merge_request: Option<RawAuto>,
}

fn cut(mut text: String) -> String {
    if let Some((i, _)) = text.char_indices().nth(PR_TEXT_MAX) {
        text.truncate(i);
    }
    text
}

fn author(l: Option<RawLogin>) -> Option<String> {
    l.map(|l| l.login).filter(|l| !l.is_empty())
}

fn verdict(state: &str) -> Option<ReviewerState> {
    match state {
        "APPROVED" => Some(ReviewerState::Approved),
        "CHANGES_REQUESTED" => Some(ReviewerState::ChangesRequested),
        "COMMENTED" => Some(ReviewerState::Commented),
        "DISMISSED" => Some(ReviewerState::Dismissed),
        // PENDING (a draft review of the viewer) and anything new say nothing yet.
        _ => None,
    }
}

impl From<RawDetail> for PrDetail {
    fn from(raw: RawDetail) -> PrDetail {
        let state = match raw.state.as_str() {
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ if raw.is_draft => PrState::Draft,
            _ => PrState::Open,
        };
        let review_decision = match raw.review_decision.as_deref() {
            Some("APPROVED") => Some(ReviewDecision::Approved),
            Some("CHANGES_REQUESTED") => Some(ReviewDecision::ChangesRequested),
            Some("REVIEW_REQUIRED") => Some(ReviewDecision::ReviewRequired),
            _ => None,
        };
        let mergeable = match raw.mergeable.as_str() {
            "MERGEABLE" => Mergeable::Mergeable,
            "CONFLICTING" => Mergeable::Conflicting,
            _ => Mergeable::Unknown,
        };
        let merge_state = match raw.merge_state_status.as_str() {
            "CLEAN" => MergeState::Clean,
            "DIRTY" => MergeState::Dirty,
            "BLOCKED" => MergeState::Blocked,
            "BEHIND" => MergeState::Behind,
            "UNSTABLE" => MergeState::Unstable,
            "HAS_HOOKS" => MergeState::HasHooks,
            "DRAFT" => MergeState::Draft,
            _ => MergeState::Unknown,
        };

        // Reviewers: the last verdict of each author, then the ones still asked.
        let mut reviewers: Vec<PrReviewer> = Vec::new();
        let mut entries: Vec<PrEntry> = Vec::new();
        for r in raw.comments {
            let url = (!r.url.is_empty()).then_some(r.url);
            entries.push(PrEntry {
                kind: PrEntryKind::Comment,
                author: author(r.author).unwrap_or_else(|| "ghost".into()),
                body: cut(r.body),
                at: r.created_at,
                url,
                review: None,
            });
        }
        for r in raw.reviews {
            let Some(state) = verdict(&r.state) else {
                continue;
            };
            let login = author(r.author).unwrap_or_else(|| "ghost".into());
            match reviewers.iter_mut().find(|x| x.login == login) {
                // A later review replaces an earlier one, except that a bare
                // comment never hides an approval or a request for changes.
                Some(x) => {
                    if state != ReviewerState::Commented || x.state == ReviewerState::Commented {
                        x.state = state;
                    }
                }
                None => reviewers.push(PrReviewer {
                    login: login.clone(),
                    state,
                }),
            }
            // A review that only comments and has nothing to say is noise.
            if state == ReviewerState::Commented && r.body.trim().is_empty() {
                continue;
            }
            let url = (!r.url.is_empty()).then_some(r.url);
            entries.push(PrEntry {
                kind: PrEntryKind::Review,
                author: login,
                body: cut(r.body),
                at: r.submitted_at,
                url,
                review: Some(state),
            });
        }
        for r in raw.review_requests {
            let name = if r.login.is_empty() { r.name } else { r.login };
            if name.is_empty() {
                continue;
            }
            match reviewers.iter_mut().find(|x| x.login == name) {
                Some(x) => x.state = ReviewerState::Requested,
                None => reviewers.push(PrReviewer {
                    login: name,
                    state: ReviewerState::Requested,
                }),
            }
        }
        // RFC 3339 in UTC sorts as text; the sort is stable, so equal times keep
        // the comments before the reviews.
        entries.sort_by(|a, b| a.at.cmp(&b.at));

        let auto_merge = raw.auto_merge_request.map(|a| PrAutoMerge {
            method: match a.merge_method.as_str() {
                "MERGE" => MergeMethod::Merge,
                "REBASE" => MergeMethod::Rebase,
                _ => MergeMethod::Squash,
            },
            enabled_by: author(a.enabled_by),
        });
        PrDetail {
            number: raw.number,
            url: raw.url,
            state,
            title: raw.title,
            body: cut(raw.body),
            author: author(raw.author),
            base: raw.base_ref_name,
            head: raw.head_ref_name,
            review_decision,
            mergeable,
            merge_state,
            reviewers,
            entries,
            files: raw
                .files
                .into_iter()
                .map(|f| PrFile {
                    path: f.path,
                    additions: f.additions,
                    deletions: f.deletions,
                })
                .collect(),
            auto_merge,
        }
    }
}

/// The PR of the current branch, whole. `None` when the branch has none.
pub fn pr_detail(gh: &dyn GhExec, cwd: &Path) -> Result<Option<PrDetail>, GitError> {
    let out = gh.run(cwd, &["pr", "view", "--json", DETAIL_FIELDS], None)?;
    if out.status != Some(0) {
        if out.stderr.contains("no pull requests found") {
            return Ok(None);
        }
        return Err(classify(&out));
    }
    let raw: RawDetail = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(Some(raw.into()))
}

/// Posts a conversation comment. The body goes on stdin.
pub fn pr_comment_add(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    body: &str,
) -> Result<(), GitError> {
    if body.trim().is_empty() {
        return Err(GitError::EmptyComment);
    }
    if body.chars().count() > COMMENT_BODY_MAX {
        return Err(GitError::CommentTooLarge);
    }
    ok(gh.run(
        cwd,
        &["pr", "comment", &number.to_string(), "--body-file", "-"],
        Some(body),
    )?)?;
    Ok(())
}

/// Arms auto-merge: GitHub merges once the checks pass and the reviews are in.
pub fn pr_auto_merge_enable(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    method: MergeMethod,
) -> Result<(), GitError> {
    let flag = match method {
        MergeMethod::Squash => "--squash",
        MergeMethod::Merge => "--merge",
        MergeMethod::Rebase => "--rebase",
    };
    ok(gh.run(
        cwd,
        &["pr", "merge", &number.to_string(), "--auto", flag],
        None,
    )?)?;
    Ok(())
}

pub fn pr_auto_merge_disable(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<(), GitError> {
    ok(gh.run(
        cwd,
        &["pr", "merge", &number.to_string(), "--disable-auto"],
        None,
    )?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use super::*;
    use crate::gh::GhOutput;

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

    const DETAIL: &str = r#"{
      "number": 42,
      "url": "https://github.com/acme/app/pull/42",
      "state": "OPEN",
      "isDraft": false,
      "title": "Add the panel",
      "body": "Closes #7",
      "baseRefName": "main",
      "headRefName": "feat/panel",
      "author": {"login": "ada"},
      "reviewDecision": "CHANGES_REQUESTED",
      "mergeable": "MERGEABLE",
      "mergeStateStatus": "BLOCKED",
      "comments": [
        {"author": {"login": "bob"}, "body": "Looks fine", "createdAt": "2026-05-02T10:00:00Z", "url": "https://github.com/acme/app/pull/42#issuecomment-1"},
        {"author": null, "body": "from a deleted user", "createdAt": "2026-05-04T10:00:00Z", "url": ""}
      ],
      "reviews": [
        {"author": {"login": "cy"}, "body": "Please rename", "state": "CHANGES_REQUESTED", "submittedAt": "2026-05-03T10:00:00Z"},
        {"author": {"login": "cy"}, "body": "", "state": "COMMENTED", "submittedAt": "2026-05-03T11:00:00Z"},
        {"author": {"login": "dee"}, "body": "", "state": "APPROVED", "submittedAt": "2026-05-01T10:00:00Z"},
        {"author": {"login": "eve"}, "body": "draft", "state": "PENDING", "submittedAt": ""}
      ],
      "reviewRequests": [
        {"__typename": "User", "login": "fay"},
        {"__typename": "Team", "name": "core", "slug": "core"},
        {"__typename": "User", "login": "dee"}
      ],
      "files": [
        {"path": "src/a.rs", "additions": 10, "deletions": 2},
        {"path": "README.md", "additions": 1, "deletions": 0}
      ],
      "autoMergeRequest": {"enabledAt": "2026-05-05T10:00:00Z", "enabledBy": {"login": "ada"}, "mergeMethod": "REBASE", "commitHeadline": "x", "commitBody": ""}
    }"#;

    #[test]
    fn detail_asks_for_the_fields_of_the_current_branch() {
        let fake = Fake::new(vec![out(0, DETAIL, "")]);
        pr_detail(&fake, cwd()).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0[..3], ["pr", "view", "--json"]);
        assert_eq!(calls[0].0.len(), 4);
        for f in [
            "comments",
            "reviews",
            "reviewRequests",
            "files",
            "autoMergeRequest",
            "mergeStateStatus",
            "reviewDecision",
        ] {
            assert!(calls[0].0[3].split(',').any(|x| x == f), "{f}");
        }
        assert_eq!(calls[0].1, None);
    }

    #[test]
    fn detail_maps_the_header() {
        let fake = Fake::new(vec![out(0, DETAIL, "")]);
        let pr = pr_detail(&fake, cwd()).unwrap().unwrap();
        assert_eq!((pr.number, pr.state), (42, PrState::Open));
        assert_eq!(pr.author.as_deref(), Some("ada"));
        assert_eq!((pr.base.as_str(), pr.head.as_str()), ("main", "feat/panel"));
        assert_eq!(pr.review_decision, Some(ReviewDecision::ChangesRequested));
        assert_eq!(pr.mergeable, Mergeable::Mergeable);
        assert_eq!(pr.merge_state, MergeState::Blocked);
        assert_eq!(pr.body, "Closes #7");
    }

    #[test]
    fn detail_orders_the_conversation_and_drops_noise() {
        let fake = Fake::new(vec![out(0, DETAIL, "")]);
        let pr = pr_detail(&fake, cwd()).unwrap().unwrap();
        let seen: Vec<(PrEntryKind, &str)> = pr
            .entries
            .iter()
            .map(|e| (e.kind, e.author.as_str()))
            .collect();
        // dee's empty approval stays (it is a verdict); cy's empty comment and
        // eve's pending review go.
        assert_eq!(
            seen,
            [
                (PrEntryKind::Review, "dee"),
                (PrEntryKind::Comment, "bob"),
                (PrEntryKind::Review, "cy"),
                (PrEntryKind::Comment, "ghost"),
            ]
        );
        assert_eq!(
            pr.entries[1].url.as_deref().map(|u| u.ends_with("-1")),
            Some(true)
        );
        assert_eq!(pr.entries[3].url, None);
    }

    #[test]
    fn detail_reviewers_keep_the_last_verdict_and_the_open_requests() {
        let fake = Fake::new(vec![out(0, DETAIL, "")]);
        let pr = pr_detail(&fake, cwd()).unwrap().unwrap();
        let got: Vec<(&str, ReviewerState)> = pr
            .reviewers
            .iter()
            .map(|r| (r.login.as_str(), r.state))
            .collect();
        assert_eq!(
            got,
            [
                // A later bare comment does not hide the request for changes.
                ("cy", ReviewerState::ChangesRequested),
                // Asked again after approving.
                ("dee", ReviewerState::Requested),
                ("fay", ReviewerState::Requested),
                ("core", ReviewerState::Requested),
            ]
        );
    }

    #[test]
    fn detail_maps_files_and_auto_merge() {
        let fake = Fake::new(vec![out(0, DETAIL, "")]);
        let pr = pr_detail(&fake, cwd()).unwrap().unwrap();
        assert_eq!(pr.files.len(), 2);
        assert_eq!(
            pr.files[0],
            PrFile {
                path: "src/a.rs".into(),
                additions: 10,
                deletions: 2
            }
        );
        assert_eq!(
            pr.auto_merge,
            Some(PrAutoMerge {
                method: MergeMethod::Rebase,
                enabled_by: Some("ada".into())
            })
        );
    }

    #[test]
    fn detail_reads_a_bare_draft_without_the_optional_fields() {
        let json = r#"{"number":3,"url":"u","state":"OPEN","isDraft":true,"title":"t",
          "baseRefName":"main","headRefName":"h","author":null,"reviewDecision":"",
          "mergeable":"UNKNOWN","mergeStateStatus":"DRAFT","autoMergeRequest":null}"#;
        let fake = Fake::new(vec![out(0, json, "")]);
        let pr = pr_detail(&fake, cwd()).unwrap().unwrap();
        assert_eq!(pr.state, PrState::Draft);
        assert_eq!(pr.author, None);
        assert_eq!(pr.review_decision, None);
        assert_eq!(pr.merge_state, MergeState::Draft);
        assert!(pr.entries.is_empty() && pr.files.is_empty() && pr.auto_merge.is_none());
    }

    #[test]
    fn detail_is_none_without_a_pull_request() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "no pull requests found for branch \"feat/x\"",
        )]);
        assert_eq!(pr_detail(&fake, cwd()).unwrap(), None);
    }

    #[test]
    fn detail_surfaces_other_failures_and_bad_json() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "To get started with GitHub CLI, run: gh auth login",
        )]);
        assert!(matches!(pr_detail(&fake, cwd()), Err(GitError::GhAuth)));
        let fake = Fake::new(vec![out(0, "[]", "")]);
        assert!(matches!(pr_detail(&fake, cwd()), Err(GitError::Gh(_))));
    }

    #[test]
    fn comment_goes_on_stdin_and_never_in_argv() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_comment_add(&fake, cwd(), 42, "ship it --body \"x\"").unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].0, ["pr", "comment", "42", "--body-file", "-"]);
        assert_eq!(calls[0].1.as_deref(), Some("ship it --body \"x\""));
    }

    #[test]
    fn comment_refuses_empty_and_oversized_bodies_before_running_gh() {
        let fake = Fake::new(vec![]);
        assert!(matches!(
            pr_comment_add(&fake, cwd(), 1, "  \n"),
            Err(GitError::EmptyComment)
        ));
        let big = "x".repeat(COMMENT_BODY_MAX + 1);
        assert!(matches!(
            pr_comment_add(&fake, cwd(), 1, &big),
            Err(GitError::CommentTooLarge)
        ));
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn comment_failure_is_an_error() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "GraphQL: Could not resolve to a PullRequest",
        )]);
        assert!(matches!(
            pr_comment_add(&fake, cwd(), 1, "hi"),
            Err(GitError::Gh(_))
        ));
    }

    #[test]
    fn auto_merge_enable_passes_the_method() {
        for (method, flag) in [
            (MergeMethod::Squash, "--squash"),
            (MergeMethod::Merge, "--merge"),
            (MergeMethod::Rebase, "--rebase"),
        ] {
            let fake = Fake::new(vec![out(0, "", "")]);
            pr_auto_merge_enable(&fake, cwd(), 42, method).unwrap();
            assert_eq!(
                fake.calls.borrow()[0].0,
                ["pr", "merge", "42", "--auto", flag]
            );
        }
    }

    #[test]
    fn auto_merge_enable_reports_a_refusal() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "GraphQL: Pull request Auto merge is not allowed for this repository",
        )]);
        let err = pr_auto_merge_enable(&fake, cwd(), 42, MergeMethod::Squash).unwrap_err();
        assert!(matches!(err, GitError::Gh(t) if t.contains("not allowed")));
    }

    #[test]
    fn auto_merge_disable_passes_the_flag() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_auto_merge_disable(&fake, cwd(), 42).unwrap();
        assert_eq!(
            fake.calls.borrow()[0].0,
            ["pr", "merge", "42", "--disable-auto"]
        );
    }
}
