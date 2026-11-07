//! Reviewing a merge request through `glab`: its detail, pipeline jobs, comments, a new comment and
//! the merge. Every call goes through `GlabExec`, so a test runs no `glab`. Every argument list
//! comes from `glab_argv`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::gh::GhOutput;
use crate::gitlab::{GlabExec, MR_BODY_LIMIT, MrState, MrSummary, classify, parse_error, parse_mr};
use crate::{Check, CheckBucket, GitError, MergeBlock, MergeMethod, PrMergeInfo};

/// Most notes and jobs one call asks for (the GitLab page maximum).
const PAGE: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MrPipeline {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub id: u64,
    pub bucket: CheckBucket,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MrDetail {
    pub summary: MrSummary,
    /// The description, Markdown.
    pub body: String,
    /// The head commit of the source branch; a merge is pinned to it.
    pub head_sha: String,
    pub pipeline: Option<MrPipeline>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MrNote {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MrNotes {
    /// Oldest first.
    pub notes: Vec<MrNote>,
    /// Older notes exist that were not fetched.
    pub truncated: bool,
}

/// One `glab` call of this module.
pub(crate) enum GlabOp<'a> {
    View {
        iid: u64,
    },
    Notes {
        iid: u64,
    },
    Jobs {
        pipeline: u64,
    },
    Project,
    NoteAdd {
        iid: u64,
        body: &'a str,
    },
    Merge {
        iid: u64,
        method: MergeMethod,
        sha: &'a str,
    },
}

/// The arguments of one call. Values that carry user text use the `--flag=value` form, so a text
/// that starts with `-` is never read as a flag. The merge never removes the source branch and
/// never schedules (`--auto-merge=false`): it merges now or fails.
pub(crate) fn glab_argv(op: &GlabOp) -> Vec<String> {
    let words: Vec<String> = match op {
        GlabOp::View { iid } => ["mr", "view", &iid.to_string(), "--output", "json"]
            .map(str::to_owned)
            .to_vec(),
        GlabOp::Notes { iid } => vec![
            "api".to_owned(),
            format!(
                "projects/:id/merge_requests/{iid}/notes?sort=desc&order_by=created_at&per_page={PAGE}"
            ),
        ],
        GlabOp::Jobs { pipeline } => vec![
            "api".to_owned(),
            format!("projects/:id/pipelines/{pipeline}/jobs?per_page={PAGE}"),
        ],
        GlabOp::Project => vec!["api".to_owned(), "projects/:id".to_owned()],
        GlabOp::NoteAdd { iid, body } => vec![
            "mr".to_owned(),
            "note".to_owned(),
            "create".to_owned(),
            iid.to_string(),
            format!("--message={body}"),
        ],
        GlabOp::Merge { iid, method, sha } => {
            let mut args = vec![
                "mr".to_owned(),
                "merge".to_owned(),
                iid.to_string(),
                "--yes".to_owned(),
                format!("--sha={sha}"),
            ];
            match method {
                MergeMethod::Squash => args.push("--squash".to_owned()),
                MergeMethod::Rebase => args.push("--rebase".to_owned()),
                MergeMethod::Merge => {}
            }
            args.push("--auto-merge=false".to_owned());
            args
        }
    };
    words
}

/// The bucket of a job or pipeline status. A failed job that may fail does not count as a failure.
pub(crate) fn job_bucket(status: &str, allow_failure: bool) -> CheckBucket {
    match status {
        "success" => CheckBucket::Pass,
        "failed" if allow_failure => CheckBucket::Skipping,
        "failed" => CheckBucket::Fail,
        "running"
        | "pending"
        | "created"
        | "preparing"
        | "waiting_for_resource"
        | "waiting_for_callback"
        | "scheduled" => CheckBucket::Pending,
        "canceled" | "canceling" => CheckBucket::Cancel,
        _ => CheckBucket::Skipping,
    }
}

#[derive(Deserialize)]
struct RawPipeline {
    id: u64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct RawDetailExtra {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    head_pipeline: Option<RawPipeline>,
    #[serde(default)]
    detailed_merge_status: Option<String>,
    #[serde(default)]
    has_conflicts: bool,
    #[serde(default)]
    merge_status: Option<String>,
}

fn pipeline_of(raw: Option<RawPipeline>) -> Option<MrPipeline> {
    raw.map(|p| MrPipeline {
        id: p.id,
        bucket: job_bucket(&p.status, false),
        url: p.web_url.filter(|u| !u.is_empty()),
    })
}

/// The detail in `glab mr view <iid> --output json` text. A missing or null `head_pipeline` is no
/// pipeline.
pub(crate) fn parse_mr_detail(json: &str) -> Result<MrDetail, GitError> {
    let summary = parse_mr(json)?;
    let extra: RawDetailExtra = serde_json::from_str(json).map_err(parse_error)?;
    Ok(MrDetail {
        summary,
        body: extra.description.unwrap_or_default(),
        head_sha: extra.sha.unwrap_or_default(),
        pipeline: pipeline_of(extra.head_pipeline),
    })
}

#[derive(Deserialize)]
struct RawJob {
    #[serde(default)]
    name: String,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    allow_failure: bool,
    #[serde(default)]
    web_url: Option<String>,
}

/// The jobs in `projects/:id/pipelines/<id>/jobs` text, in API order.
pub(crate) fn parse_jobs(json: &str) -> Result<Vec<Check>, GitError> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawJob> = serde_json::from_str(json).map_err(parse_error)?;
    Ok(raw
        .into_iter()
        .map(|j| Check {
            name: j.name,
            workflow: j.stage.filter(|s| !s.is_empty()),
            bucket: job_bucket(&j.status, j.allow_failure),
            link: j.web_url.filter(|u| !u.is_empty()),
        })
        .collect())
}

#[derive(Deserialize)]
struct RawNoteAuthor {
    #[serde(default)]
    username: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawNote {
    id: u64,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Option<RawNoteAuthor>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    system: bool,
}

/// The notes in `projects/:id/merge_requests/<iid>/notes?sort=desc..` text: system notes dropped,
/// oldest first.
pub(crate) fn parse_notes(json: &str) -> Result<MrNotes, GitError> {
    if json.trim().is_empty() {
        return Ok(MrNotes {
            notes: Vec::new(),
            truncated: false,
        });
    }
    let raw: Vec<RawNote> = serde_json::from_str(json).map_err(parse_error)?;
    let truncated = raw.len() >= PAGE;
    let mut notes: Vec<MrNote> = raw
        .into_iter()
        .filter(|n| !n.system)
        .map(|n| {
            let author = n.author.map_or_else(String::new, |a| {
                if a.username.is_empty() {
                    a.name
                } else {
                    a.username
                }
            });
            MrNote {
                id: n.id,
                author,
                body: n.body,
                created_at: n.created_at,
            }
        })
        .collect();
    notes.reverse();
    Ok(MrNotes { notes, truncated })
}

#[derive(Deserialize)]
struct RawProject {
    #[serde(default)]
    squash_option: Option<String>,
}

/// The block of a merge request, in the order the reasons are checked.
fn block_of(detail: &MrDetail, extra: &RawDetailExtra) -> Option<MergeBlock> {
    match detail.summary.state {
        MrState::Merged => return Some(MergeBlock::Merged),
        MrState::Closed => return Some(MergeBlock::Closed),
        MrState::Open => {}
    }
    if detail.summary.draft {
        return Some(MergeBlock::Draft);
    }
    let status = extra.detailed_merge_status.as_deref();
    if extra.has_conflicts || status == Some("conflict") {
        return Some(MergeBlock::Conflicts);
    }
    match status {
        Some("not_approved" | "approvals_syncing") => Some(MergeBlock::ReviewRequired),
        Some("requested_changes") => Some(MergeBlock::ChangesRequested),
        Some("need_rebase") => Some(MergeBlock::Behind),
        Some("unchecked" | "checking" | "preparing") => Some(MergeBlock::Unknown),
        Some("mergeable") => None,
        Some(_) => Some(MergeBlock::Blocked),
        None => match extra.merge_status.as_deref() {
            Some("can_be_merged") => None,
            Some("cannot_be_merged") => Some(MergeBlock::Conflicts),
            _ => Some(MergeBlock::Unknown),
        },
    }
}

/// The methods a project allows and the one to preselect, from its `squash_option`.
fn methods_of(squash_option: Option<&str>) -> (Vec<MergeMethod>, MergeMethod) {
    use MergeMethod::{Merge, Rebase, Squash};
    match squash_option {
        Some("never") => (vec![Merge, Rebase], Merge),
        Some("always") => (vec![Squash], Squash),
        Some("default_on") => (vec![Squash, Merge, Rebase], Squash),
        _ => (vec![Squash, Merge, Rebase], Merge),
    }
}

/// The merge state from the `glab mr view` text and the `projects/:id` text.
pub(crate) fn merge_info_from(
    detail_json: &str,
    project_json: &str,
) -> Result<PrMergeInfo, GitError> {
    let detail = parse_mr_detail(detail_json)?;
    let extra: RawDetailExtra = serde_json::from_str(detail_json).map_err(parse_error)?;
    let project: RawProject = serde_json::from_str(project_json).map_err(parse_error)?;
    let (methods, default_method) = methods_of(project.squash_option.as_deref());
    Ok(PrMergeInfo {
        block: block_of(&detail, &extra),
        checks_failed: detail
            .pipeline
            .as_ref()
            .is_some_and(|p| p.bucket == CheckBucket::Fail),
        methods,
        default_method,
        head_oid: detail.head_sha,
    })
}

/// The block a refused merge names, from glab's text.
pub(crate) fn mr_merge_refusal(text: &str) -> Option<MergeBlock> {
    let t = text.to_lowercase();
    if t.contains("already merged") {
        Some(MergeBlock::Merged)
    } else if t.contains("closed") {
        Some(MergeBlock::Closed)
    } else if t.contains("draft") {
        Some(MergeBlock::Draft)
    } else if t.contains("conflict") {
        Some(MergeBlock::Conflicts)
    } else if t.contains("not approved") {
        Some(MergeBlock::ReviewRequired)
    } else if t.contains("rebase") {
        Some(MergeBlock::Behind)
    } else if t.contains("pipeline") || t.contains("not mergeable") {
        Some(MergeBlock::Blocked)
    } else {
        None
    }
}

fn run_op(glab: &dyn GlabExec, cwd: &Path, op: &GlabOp) -> Result<GhOutput, GitError> {
    let args = glab_argv(op);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    glab.run(cwd, &args)
}

/// Stdout of a successful call; a failed one is `MrNotFound` on a 404 when `gone` asks for it,
/// else the common reading.
fn ok_stdout(out: GhOutput, gone: bool) -> Result<String, GitError> {
    if out.status == Some(0) {
        return Ok(out.stdout);
    }
    if gone && out.stderr.contains("404") {
        return Err(GitError::MrNotFound);
    }
    Err(classify(&out))
}

pub fn glab_mr_detail(glab: &dyn GlabExec, cwd: &Path, iid: u64) -> Result<MrDetail, GitError> {
    let out = run_op(glab, cwd, &GlabOp::View { iid })?;
    parse_mr_detail(&ok_stdout(out, true)?)
}

pub fn glab_pipeline_jobs(
    glab: &dyn GlabExec,
    cwd: &Path,
    pipeline: u64,
) -> Result<Vec<Check>, GitError> {
    let out = run_op(glab, cwd, &GlabOp::Jobs { pipeline })?;
    parse_jobs(&ok_stdout(out, false)?)
}

pub fn glab_mr_notes(glab: &dyn GlabExec, cwd: &Path, iid: u64) -> Result<MrNotes, GitError> {
    let out = run_op(glab, cwd, &GlabOp::Notes { iid })?;
    parse_notes(&ok_stdout(out, true)?)
}

/// Adds a comment. A blank text is `EmptyComment`, one over `MR_BODY_LIMIT` UTF-16 units is
/// `CommentTooLarge`; glab does not run in either case.
pub fn glab_mr_note_add(
    glab: &dyn GlabExec,
    cwd: &Path,
    iid: u64,
    body: &str,
) -> Result<(), GitError> {
    if body.trim().is_empty() {
        return Err(GitError::EmptyComment);
    }
    if body.encode_utf16().count() > MR_BODY_LIMIT {
        return Err(GitError::CommentTooLarge);
    }
    let out = run_op(glab, cwd, &GlabOp::NoteAdd { iid, body })?;
    ok_stdout(out, true).map(|_| ())
}

pub fn glab_mr_merge_info(
    glab: &dyn GlabExec,
    cwd: &Path,
    iid: u64,
) -> Result<PrMergeInfo, GitError> {
    let view = run_op(glab, cwd, &GlabOp::View { iid })?;
    let detail = ok_stdout(view, true)?;
    let project = run_op(glab, cwd, &GlabOp::Project)?;
    let project = ok_stdout(project, false)?;
    merge_info_from(&detail, &project)
}

/// Merges now with `method`, only if the source head is still `head_sha`: a moved head is
/// `PrHeadMoved`. The source branch is left alone. A refusal is mapped to `MergeBlocked`.
pub fn glab_mr_merge(
    glab: &dyn GlabExec,
    cwd: &Path,
    iid: u64,
    method: MergeMethod,
    head_sha: &str,
) -> Result<(), GitError> {
    if !(4..=64).contains(&head_sha.len()) || !head_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::BadId(head_sha.to_owned()));
    }
    let out = run_op(
        glab,
        cwd,
        &GlabOp::Merge {
            iid,
            method,
            sha: head_sha,
        },
    )?;
    if out.status == Some(0) {
        return Ok(());
    }
    match classify(&out) {
        GitError::Glab(text) if text.to_lowercase().contains("sha does not match") => {
            Err(GitError::PrHeadMoved)
        }
        GitError::Glab(text) => {
            Err(mr_merge_refusal(&text).map_or(GitError::Glab(text), GitError::MergeBlocked))
        }
        other => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    const DETAIL: &str = include_str!("../fixtures/glab_mr_detail.json");
    const NOTES: &str = include_str!("../fixtures/glab_mr_notes.json");
    const JOBS: &str = include_str!("../fixtures/glab_pipeline_jobs.json");
    const PROJECT: &str = include_str!("../fixtures/glab_project.json");

    /// Answers each call with the next scripted output and records the argv.
    struct Script {
        calls: RefCell<Vec<Vec<String>>>,
        outs: RefCell<VecDeque<GhOutput>>,
    }

    fn out(status: i32, stdout: &str, stderr: &str) -> GhOutput {
        GhOutput {
            status: Some(status),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    impl Script {
        fn new(outs: Vec<GhOutput>) -> Script {
            Script {
                calls: RefCell::default(),
                outs: RefCell::new(outs.into()),
            }
        }
    }

    impl GlabExec for Script {
        fn run(&self, _: &Path, args: &[&str]) -> Result<GhOutput, GitError> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            Ok(self
                .outs
                .borrow_mut()
                .pop_front()
                .expect("unscripted glab call"))
        }
    }

    fn cwd() -> &'static Path {
        Path::new(".")
    }

    /// The detail fixture with one top-level field replaced.
    fn detail_with(key: &str, value: serde_json::Value) -> String {
        let mut v: serde_json::Value = serde_json::from_str(DETAIL).unwrap();
        v[key] = value;
        v.to_string()
    }

    #[test]
    fn argv_of_every_op() {
        assert_eq!(
            glab_argv(&GlabOp::View { iid: 12 }),
            ["mr", "view", "12", "--output", "json"]
        );
        assert_eq!(
            glab_argv(&GlabOp::Notes { iid: 12 }),
            [
                "api",
                "projects/:id/merge_requests/12/notes?sort=desc&order_by=created_at&per_page=100"
            ]
        );
        assert_eq!(
            glab_argv(&GlabOp::Jobs { pipeline: 99 }),
            ["api", "projects/:id/pipelines/99/jobs?per_page=100"]
        );
        assert_eq!(glab_argv(&GlabOp::Project), ["api", "projects/:id"]);
        assert_eq!(
            glab_argv(&GlabOp::NoteAdd {
                iid: 12,
                body: "-rf"
            }),
            ["mr", "note", "create", "12", "--message=-rf"]
        );
    }

    #[test]
    fn merge_argv_by_method() {
        let argv = |method| {
            glab_argv(&GlabOp::Merge {
                iid: 12,
                method,
                sha: "abc1234",
            })
        };
        assert_eq!(
            argv(MergeMethod::Squash),
            [
                "mr",
                "merge",
                "12",
                "--yes",
                "--sha=abc1234",
                "--squash",
                "--auto-merge=false"
            ]
        );
        assert_eq!(
            argv(MergeMethod::Merge),
            [
                "mr",
                "merge",
                "12",
                "--yes",
                "--sha=abc1234",
                "--auto-merge=false"
            ]
        );
        assert!(argv(MergeMethod::Rebase).contains(&"--rebase".to_owned()));
        for method in [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase] {
            let args = argv(method);
            assert!(
                !args
                    .iter()
                    .any(|a| a == "-d" || a == "--remove-source-branch")
            );
        }
    }

    #[test]
    fn detail_is_read_from_the_fixture() {
        let d = parse_mr_detail(DETAIL).unwrap();
        assert_eq!(d.summary.iid, 12);
        assert_eq!(d.summary.state, MrState::Open);
        assert!(d.body.starts_with("Fixes the **footer** meter"));
        assert_eq!(d.head_sha, "abc1234def5678abc1234def5678abc1234def56");
        assert_eq!(
            d.pipeline,
            Some(MrPipeline {
                id: 99,
                bucket: CheckBucket::Fail,
                url: Some("https://gitlab.com/acme/app/-/pipelines/99".into()),
            })
        );
        let none = parse_mr_detail(&detail_with("head_pipeline", serde_json::Value::Null)).unwrap();
        assert_eq!(none.pipeline, None);
        let bare = parse_mr_detail(r#"{"iid":3,"description":null}"#).unwrap();
        assert_eq!((bare.body.as_str(), bare.head_sha.as_str()), ("", ""));
        assert_eq!(bare.pipeline, None);
    }

    #[test]
    fn job_buckets() {
        use CheckBucket::*;
        for (status, allow, want) in [
            ("success", false, Pass),
            ("failed", false, Fail),
            ("failed", true, Skipping),
            ("running", false, Pending),
            ("pending", false, Pending),
            ("created", false, Pending),
            ("preparing", false, Pending),
            ("waiting_for_resource", false, Pending),
            ("scheduled", false, Pending),
            ("waiting_for_callback", false, Pending),
            ("canceled", false, Cancel),
            ("canceling", false, Cancel),
            ("skipped", false, Skipping),
            ("manual", false, Skipping),
            ("something_new", false, Skipping),
        ] {
            assert_eq!(job_bucket(status, allow), want, "{status} {allow}");
        }
    }

    #[test]
    fn jobs_keep_api_order() {
        let jobs = parse_jobs(JOBS).unwrap();
        let names: Vec<&str> = jobs.iter().map(|j| j.name.as_str()).collect();
        assert_eq!(names, ["lint", "unit", "flaky", "deploy"]);
        assert_eq!(jobs[0].workflow.as_deref(), Some("test"));
        assert_eq!(
            jobs[1].link.as_deref(),
            Some("https://gitlab.com/acme/app/-/jobs/702")
        );
        assert_eq!(jobs[1].bucket, CheckBucket::Fail);
        assert_eq!(jobs[2].bucket, CheckBucket::Skipping);
        assert_eq!(jobs[3].link, None);
        assert!(parse_jobs("  ").unwrap().is_empty());
    }

    #[test]
    fn notes_drop_system_and_read_oldest_first() {
        let got = parse_notes(NOTES).unwrap();
        let ids: Vec<u64> = got.notes.iter().map(|n| n.id).collect();
        assert_eq!(ids, [301, 303]);
        assert_eq!(got.notes[0].author, "ann");
        assert_eq!(got.notes[0].body, "First comment");
        assert!(!got.truncated);
        let many: Vec<String> = (0..100)
            .map(|i| format!(r#"{{"id":{i},"body":"b","author":{{"username":"u"}}}}"#))
            .collect();
        let full = parse_notes(&format!("[{}]", many.join(","))).unwrap();
        assert!(full.truncated);
        assert_eq!(full.notes.len(), 100);
    }

    fn block_for(detail: &str) -> Option<MergeBlock> {
        merge_info_from(detail, PROJECT).unwrap().block
    }

    #[test]
    fn merge_blocks_follow_the_ruling_order() {
        let status = |s: &str| block_for(&detail_with("detailed_merge_status", s.into()));
        assert_eq!(block_for(DETAIL), None);
        assert_eq!(
            block_for(&detail_with("state", "merged".into())),
            Some(MergeBlock::Merged)
        );
        assert_eq!(
            block_for(&detail_with("state", "closed".into())),
            Some(MergeBlock::Closed)
        );
        assert_eq!(
            block_for(&detail_with("draft", true.into())),
            Some(MergeBlock::Draft)
        );
        assert_eq!(
            block_for(&detail_with("has_conflicts", true.into())),
            Some(MergeBlock::Conflicts)
        );
        for (value, want) in [
            ("conflict", Some(MergeBlock::Conflicts)),
            ("not_approved", Some(MergeBlock::ReviewRequired)),
            ("approvals_syncing", Some(MergeBlock::ReviewRequired)),
            ("requested_changes", Some(MergeBlock::ChangesRequested)),
            ("need_rebase", Some(MergeBlock::Behind)),
            ("unchecked", Some(MergeBlock::Unknown)),
            ("checking", Some(MergeBlock::Unknown)),
            ("preparing", Some(MergeBlock::Unknown)),
            ("mergeable", None),
            ("ci_must_pass", Some(MergeBlock::Blocked)),
            ("discussions_not_resolved", Some(MergeBlock::Blocked)),
        ] {
            assert_eq!(status(value), want, "{value}");
        }
        // A draft with conflicts reads as a draft: the order is fixed.
        let mut v: serde_json::Value = serde_json::from_str(DETAIL).unwrap();
        v["draft"] = true.into();
        v["has_conflicts"] = true.into();
        assert_eq!(block_for(&v.to_string()), Some(MergeBlock::Draft));
    }

    #[test]
    fn merge_status_is_the_fallback() {
        let mut v: serde_json::Value = serde_json::from_str(DETAIL).unwrap();
        v.as_object_mut().unwrap().remove("detailed_merge_status");
        let mut with = |s: &str| {
            v["merge_status"] = s.into();
            block_for(&v.to_string())
        };
        assert_eq!(with("can_be_merged"), None);
        assert_eq!(with("cannot_be_merged"), Some(MergeBlock::Conflicts));
        assert_eq!(with("checking"), Some(MergeBlock::Unknown));
        assert_eq!(with("unchecked"), Some(MergeBlock::Unknown));
    }

    #[test]
    fn merge_info_reads_head_checks_and_methods() {
        let info = merge_info_from(DETAIL, PROJECT).unwrap();
        assert_eq!(info.head_oid, "abc1234def5678abc1234def5678abc1234def56");
        assert!(info.checks_failed, "the fixture pipeline failed");
        assert_eq!(
            info.methods,
            [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase]
        );
        assert_eq!(info.default_method, MergeMethod::Squash);
        let none = detail_with("head_pipeline", serde_json::Value::Null);
        assert!(!merge_info_from(&none, PROJECT).unwrap().checks_failed);
    }

    #[test]
    fn project_squash_option_sets_the_methods() {
        use MergeMethod::*;
        let with = |opt: &str| {
            let info = merge_info_from(DETAIL, &format!(r#"{{"squash_option":"{opt}"}}"#)).unwrap();
            (info.methods, info.default_method)
        };
        assert_eq!(with("never"), (vec![Merge, Rebase], Merge));
        assert_eq!(with("always"), (vec![Squash], Squash));
        assert_eq!(with("default_on"), (vec![Squash, Merge, Rebase], Squash));
        assert_eq!(with("default_off"), (vec![Squash, Merge, Rebase], Merge));
        let missing = merge_info_from(DETAIL, "{}").unwrap();
        assert_eq!(missing.default_method, Merge);
    }

    #[test]
    fn refusals_map_to_blocks() {
        for (text, want) in [
            ("Merge request is already merged", Some(MergeBlock::Merged)),
            ("merge request is closed", Some(MergeBlock::Closed)),
            ("cannot merge a draft", Some(MergeBlock::Draft)),
            (
                "this merge request has conflicts",
                Some(MergeBlock::Conflicts),
            ),
            ("MR not approved", Some(MergeBlock::ReviewRequired)),
            ("source branch needs a rebase", Some(MergeBlock::Behind)),
            ("pipeline must succeed", Some(MergeBlock::Blocked)),
            ("Merge request is not mergeable", Some(MergeBlock::Blocked)),
            ("network unreachable", None),
        ] {
            assert_eq!(mr_merge_refusal(text), want, "{text}");
        }
    }

    #[test]
    fn each_call_runs_its_argv() {
        let fake = Script::new(vec![out(0, DETAIL, "")]);
        glab_mr_detail(&fake, cwd(), 12).unwrap();
        assert_eq!(fake.calls.borrow()[0], glab_argv(&GlabOp::View { iid: 12 }));

        let fake = Script::new(vec![out(0, JOBS, "")]);
        assert_eq!(glab_pipeline_jobs(&fake, cwd(), 99).unwrap().len(), 4);
        assert_eq!(
            fake.calls.borrow()[0],
            glab_argv(&GlabOp::Jobs { pipeline: 99 })
        );

        let fake = Script::new(vec![out(0, NOTES, "")]);
        assert_eq!(glab_mr_notes(&fake, cwd(), 12).unwrap().notes.len(), 2);
        assert_eq!(
            fake.calls.borrow()[0],
            glab_argv(&GlabOp::Notes { iid: 12 })
        );

        let fake = Script::new(vec![out(0, "", "")]);
        glab_mr_note_add(&fake, cwd(), 12, "Looks good").unwrap();
        assert_eq!(
            fake.calls.borrow()[0],
            glab_argv(&GlabOp::NoteAdd {
                iid: 12,
                body: "Looks good"
            })
        );

        let fake = Script::new(vec![out(0, "", "")]);
        glab_mr_merge(&fake, cwd(), 12, MergeMethod::Squash, "abc1234").unwrap();
        assert_eq!(
            fake.calls.borrow()[0],
            glab_argv(&GlabOp::Merge {
                iid: 12,
                method: MergeMethod::Squash,
                sha: "abc1234"
            })
        );
    }

    #[test]
    fn merge_info_makes_two_calls() {
        let fake = Script::new(vec![out(0, DETAIL, ""), out(0, PROJECT, "")]);
        glab_mr_merge_info(&fake, cwd(), 12).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], glab_argv(&GlabOp::View { iid: 12 }));
        assert_eq!(calls[1], glab_argv(&GlabOp::Project));
    }

    #[test]
    fn failures_map_to_codes() {
        let code = |stderr: &str| {
            glab_mr_detail(&Script::new(vec![out(1, "", stderr)]), cwd(), 12)
                .unwrap_err()
                .code()
        };
        assert_eq!(code("run glab auth login"), "glab_auth");
        assert_eq!(
            code("GET https://x/api/v4/y: 404 Not Found"),
            "mr_not_found"
        );
        assert_eq!(code("boom"), "glab_failed");
        let jobs = glab_pipeline_jobs(&Script::new(vec![out(1, "", "404 Not Found")]), cwd(), 1)
            .unwrap_err();
        assert_eq!(jobs.code(), "glab_failed");
    }

    #[test]
    fn comments_are_checked_before_glab_runs() {
        let fake = Script::new(vec![]);
        for blank in ["", "  \n\t"] {
            assert_eq!(
                glab_mr_note_add(&fake, cwd(), 12, blank)
                    .unwrap_err()
                    .code(),
                "empty_comment"
            );
        }
        let long = "a".repeat(MR_BODY_LIMIT + 1);
        assert_eq!(
            glab_mr_note_add(&fake, cwd(), 12, &long)
                .unwrap_err()
                .code(),
            "comment_too_large"
        );
        // 8 001 astral characters are 16 002 UTF-16 units.
        let wide = "\u{1F600}".repeat(8_001);
        assert_eq!(
            glab_mr_note_add(&fake, cwd(), 12, &wide)
                .unwrap_err()
                .code(),
            "comment_too_large"
        );
        assert!(fake.calls.borrow().is_empty());
        let fake = Script::new(vec![out(0, "", "")]);
        glab_mr_note_add(&fake, cwd(), 12, &"a".repeat(MR_BODY_LIMIT)).unwrap();
        assert_eq!(fake.calls.borrow().len(), 1);
    }

    #[test]
    fn merge_errors_are_mapped() {
        let bad = Script::new(vec![]);
        assert_eq!(
            glab_mr_merge(&bad, cwd(), 12, MergeMethod::Merge, "xyz")
                .unwrap_err()
                .code(),
            "git"
        );
        assert!(bad.calls.borrow().is_empty());
        let run = |stderr: &str| {
            glab_mr_merge(
                &Script::new(vec![out(1, "", stderr)]),
                cwd(),
                12,
                MergeMethod::Merge,
                "abc1234",
            )
            .unwrap_err()
        };
        assert!(matches!(
            run("SHA does not match HEAD of source branch"),
            GitError::PrHeadMoved
        ));
        assert!(matches!(
            run("Merge request is not mergeable"),
            GitError::MergeBlocked(MergeBlock::Blocked)
        ));
        assert_eq!(run("run glab auth login").code(), "glab_auth");
        assert!(matches!(run("weird"), GitError::Glab(m) if m == "weird"));
    }
}
