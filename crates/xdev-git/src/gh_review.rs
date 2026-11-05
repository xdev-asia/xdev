//! Review on a pull request through `gh`: comments, threads, reactions,
//! check reruns and merge. Every call goes through `GhExec`, so a test runs
//! no `gh`. Bodies go on stdin, never in argv.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{CheckBucket, GhExec, classify, ok, parse_error, pr_checks, repo_name, run_id};

/// Chars kept of a comment body, in and out.
pub const COMMENT_BODY_MAX: usize = 64 * 1024;
/// Most comments one read keeps of each source (threads, conversation, reviews).
pub const COMMENTS_PER_SOURCE: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PrCommentKind {
    /// A comment in a review thread on a line of the diff.
    Thread,
    /// The body of a submitted review.
    Review,
    /// A comment in the PR conversation.
    Conversation,
}

/// GitHub's `ReactionContent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reaction {
    ThumbsUp,
    ThumbsDown,
    Laugh,
    Confused,
    Heart,
    Hooray,
    Rocket,
    Eyes,
}

impl Reaction {
    /// The spelling GraphQL takes.
    pub fn as_str(self) -> &'static str {
        match self {
            Reaction::ThumbsUp => "THUMBS_UP",
            Reaction::ThumbsDown => "THUMBS_DOWN",
            Reaction::Laugh => "LAUGH",
            Reaction::Confused => "CONFUSED",
            Reaction::Heart => "HEART",
            Reaction::Hooray => "HOORAY",
            Reaction::Rocket => "ROCKET",
            Reaction::Eyes => "EYES",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrReaction {
    pub content: Reaction,
    pub count: u32,
    /// The signed-in login reacted this way.
    pub mine: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    /// The database id: the REST id a reply is posted to.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub id: u64,
    /// The GraphQL id: the subject of a reaction.
    pub node_id: String,
    pub kind: PrCommentKind,
    /// `ghost` when GitHub has no author any more.
    pub author: String,
    /// The author's GraphQL type is `Bot`.
    pub author_bot: bool,
    pub body: String,
    /// `submittedAt` for a review.
    pub created_at: String,
    pub url: String,
    pub path: Option<String>,
    /// `line`, else `originalLine`.
    pub line: Option<u32>,
    /// `startLine`, else `originalStartLine`.
    pub start_line: Option<u32>,
    pub thread_id: Option<String>,
    /// The root comment of the thread, on a reply.
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub reply_to: Option<u64>,
    pub resolved: bool,
    /// The thread's line is gone (`line` is null).
    pub outdated: bool,
    /// On the thread root, unless it is on the left side.
    pub diff_hunk: Option<String>,
    pub reactions: Vec<PrReaction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrComments {
    /// Oldest first.
    pub comments: Vec<PrComment>,
    /// A source (or the replies of a thread) holds more than one page, so older
    /// items were left out.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrCommentDraft {
    pub body: String,
    /// Reply in the review thread whose root has this id.
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub reply_to: Option<u64>,
    /// An inline comment on this file of the PR head.
    pub path: Option<String>,
    pub line: Option<u32>,
    pub start_line: Option<u32>,
    /// The commit the line numbers refer to (the worktree `HEAD`). An inline
    /// comment is refused unless it is the PR head.
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

/// Why a PR cannot be merged from here, in the order the reasons are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum MergeBlock {
    Merged,
    Closed,
    Draft,
    ReviewRequired,
    ChangesRequested,
    Conflicts,
    MergeQueue,
    Unknown,
    Behind,
    Blocked,
}

impl MergeBlock {
    pub fn as_str(self) -> &'static str {
        match self {
            MergeBlock::Merged => "merged",
            MergeBlock::Closed => "closed",
            MergeBlock::Draft => "draft",
            MergeBlock::ReviewRequired => "review-required",
            MergeBlock::ChangesRequested => "changes-requested",
            MergeBlock::Conflicts => "conflicts",
            MergeBlock::MergeQueue => "merge-queue",
            MergeBlock::Unknown => "unknown",
            MergeBlock::Behind => "behind",
            MergeBlock::Blocked => "blocked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrMergeInfo {
    pub block: Option<MergeBlock>,
    /// A check in the rollup failed or errored.
    pub checks_failed: bool,
    /// Allowed methods, in squash, merge, rebase order.
    pub methods: Vec<MergeMethod>,
    pub default_method: MergeMethod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RerunReport {
    /// Runs a rerun was asked for.
    pub started: u32,
    /// Checks that are not GitHub Actions runs, so were not rerun.
    pub skipped: u32,
}

const COMMENTS_QUERY: &str = r#"
fragment R on Reactable { reactionGroups { content viewerHasReacted reactors { totalCount } } }
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(last: 100) { pageInfo { hasPreviousPage } nodes {
        id isResolved line originalLine startLine originalStartLine path diffSide
        comments(first: 100) { pageInfo { hasNextPage } nodes {
          id databaseId body createdAt url diffHunk
          author { login __typename } replyTo { databaseId } ...R } } } }
      comments(last: 100) { pageInfo { hasPreviousPage } nodes {
        id databaseId body createdAt url author { login __typename } ...R } }
      reviews(last: 100) { pageInfo { hasPreviousPage } nodes {
        id databaseId body submittedAt url author { login __typename } ...R } }
    }
  }
}
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    #[serde(default)]
    has_previous_page: bool,
    #[serde(default)]
    has_next_page: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Nodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
    page_info: Option<PageInfo>,
}

impl<T> Nodes<T> {
    /// Older (or later) items exist than the page holds. Without page info a full page counts.
    fn more(&self) -> bool {
        match &self.page_info {
            Some(p) => p.has_previous_page || p.has_next_page,
            None => self.nodes.len() >= COMMENTS_PER_SOURCE,
        }
    }
}

#[derive(Deserialize)]
struct RawAuthor {
    login: String,
    #[serde(rename = "__typename", default)]
    typename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGroup {
    content: Reaction,
    #[serde(default)]
    viewer_has_reacted: bool,
    reactors: RawCount,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCount {
    total_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReplyTo {
    database_id: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    id: String,
    database_id: Option<u64>,
    #[serde(default)]
    body: String,
    created_at: Option<String>,
    submitted_at: Option<String>,
    #[serde(default)]
    url: String,
    diff_hunk: Option<String>,
    author: Option<RawAuthor>,
    reply_to: Option<RawReplyTo>,
    #[serde(default)]
    reaction_groups: Vec<RawGroup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    id: String,
    #[serde(default)]
    is_resolved: bool,
    line: Option<u32>,
    original_line: Option<u32>,
    start_line: Option<u32>,
    original_start_line: Option<u32>,
    path: Option<String>,
    diff_side: Option<String>,
    comments: Nodes<RawComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPull {
    review_threads: Nodes<RawThread>,
    comments: Nodes<RawComment>,
    reviews: Nodes<RawComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
    pull_request: Option<RawPull>,
}

#[derive(Deserialize)]
struct RawData {
    repository: Option<RawRepo>,
}

#[derive(Deserialize)]
struct RawAnswer {
    data: Option<RawData>,
}

/// Cuts `text` to `COMMENT_BODY_MAX` chars.
fn cut_body(mut text: String) -> String {
    if let Some((at, _)) = text.char_indices().nth(COMMENT_BODY_MAX) {
        text.truncate(at);
    }
    text
}

/// A body that holds something besides HTML comments (bots leave markers).
fn visible(body: &str) -> bool {
    let mut rest = body;
    let mut shown = String::new();
    while let Some(start) = rest.find("<!--") {
        shown.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => {
                rest = "";
                break;
            }
        }
    }
    shown.push_str(rest);
    !shown.trim().is_empty()
}

fn reactions(groups: Vec<RawGroup>) -> Vec<PrReaction> {
    groups
        .into_iter()
        .filter(|g| g.reactors.total_count > 0)
        .map(|g| PrReaction {
            content: g.content,
            count: g.reactors.total_count,
            mine: g.viewer_has_reacted,
        })
        .collect()
}

fn base(raw: RawComment, kind: PrCommentKind) -> Option<PrComment> {
    let (author, author_bot) = match raw.author {
        Some(a) => (a.login, a.typename == "Bot"),
        None => ("ghost".to_owned(), false),
    };
    Some(PrComment {
        id: raw.database_id?,
        node_id: raw.id,
        kind,
        author,
        author_bot,
        body: cut_body(raw.body),
        created_at: raw.created_at.or(raw.submitted_at).unwrap_or_default(),
        url: raw.url,
        path: None,
        line: None,
        start_line: None,
        thread_id: None,
        reply_to: raw.reply_to.and_then(|r| r.database_id),
        resolved: false,
        outdated: false,
        diff_hunk: raw.diff_hunk,
        reactions: reactions(raw.reaction_groups),
    })
}

/// The newest `COMMENTS_PER_SOURCE` of each source, oldest first, from one
/// GraphQL call (`last: 100`, so a busy PR keeps its latest comments). A partial
/// answer (`errors` next to `data`) keeps what came back.
pub fn pr_comments(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<PrComments, GitError> {
    let repo = repo_name(gh, cwd)?;
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| GitError::Gh(format!("unexpected repo name: {repo}")))?;
    let out = gh.run(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={COMMENTS_QUERY}"),
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
        ],
        None,
    )?;
    // `gh api` exits 1 when GraphQL reports errors, but still prints the body.
    let pull = serde_json::from_str::<RawAnswer>(&out.stdout)
        .ok()
        .and_then(|a| a.data)
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_request);
    let Some(pull) = pull else {
        ok(out)?;
        return Err(GitError::PrNotFound);
    };
    let truncated = pull.review_threads.more()
        || pull.comments.more()
        || pull.reviews.more()
        || pull.review_threads.nodes.iter().any(|t| t.comments.more());
    let mut comments = Vec::new();
    for thread in pull.review_threads.nodes {
        let outdated = thread.line.is_none();
        let line = thread.line.or(thread.original_line);
        let start_line = thread.start_line.or(thread.original_start_line);
        let left = thread.diff_side.as_deref() == Some("LEFT");
        let mut root = None;
        for (i, raw) in thread.comments.nodes.into_iter().enumerate() {
            let Some(mut c) = base(raw, PrCommentKind::Thread) else {
                continue;
            };
            if i == 0 {
                root = Some(c.id);
                c.reply_to = None;
                if left {
                    c.diff_hunk = None;
                }
            } else {
                c.reply_to = c.reply_to.or(root);
                c.diff_hunk = None;
            }
            c.path = thread.path.clone();
            c.line = line;
            c.start_line = start_line;
            c.thread_id = Some(thread.id.clone());
            c.resolved = thread.is_resolved;
            c.outdated = outdated;
            comments.push(c);
        }
    }
    for raw in pull.comments.nodes {
        if let Some(c) = base(raw, PrCommentKind::Conversation) {
            comments.push(c);
        }
    }
    for raw in pull.reviews.nodes {
        if !visible(&raw.body) {
            continue;
        }
        if let Some(c) = base(raw, PrCommentKind::Review) {
            comments.push(c);
        }
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(PrComments {
        comments,
        truncated,
    })
}

fn post_json(
    gh: &dyn GhExec,
    cwd: &Path,
    endpoint: &str,
    body: &serde_json::Value,
) -> Result<(), GitError> {
    let text = body.to_string();
    ok(gh.run(
        cwd,
        &["api", "--method", "POST", endpoint, "--input", "-"],
        Some(&text),
    )?)?;
    Ok(())
}

/// A reply GitHub refused to thread: the thread is gone or the comment is not
/// a review comment.
fn refused(err: &GitError) -> bool {
    match err {
        GitError::Gh(text) => ["HTTP 422", "HTTP 404", "Unprocessable", "Not Found"]
            .iter()
            .any(|m| text.contains(m)),
        _ => false,
    }
}

/// The first line of `text`, quoted for a conversation comment.
fn quote(author: &str, text: &str) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    format!("> @{author}: {first}")
}

/// Posts a conversation comment, a reply in a review thread (a conversation
/// comment quoting the author when GitHub refuses to thread it) or, with a
/// `path` and `line`, an inline comment on the PR head. The body goes on
/// stdin as JSON.
pub fn pr_comment_post(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    draft: &PrCommentDraft,
) -> Result<(), GitError> {
    if draft.body.trim().is_empty() {
        return Err(GitError::EmptyComment);
    }
    if draft.body.chars().count() > COMMENT_BODY_MAX {
        return Err(GitError::CommentTooLarge);
    }
    let repo = repo_name(gh, cwd)?;
    let conversation = |body: &str| {
        post_json(
            gh,
            cwd,
            &format!("repos/{repo}/issues/{number}/comments"),
            &serde_json::json!({ "body": body }),
        )
    };
    if let Some(id) = draft.reply_to {
        let sent = post_json(
            gh,
            cwd,
            &format!("repos/{repo}/pulls/{number}/comments/{id}/replies"),
            &serde_json::json!({ "body": draft.body }),
        );
        return match sent {
            Err(e) if refused(&e) => {
                let (author, text) = replied_comment(gh, cwd, &repo, id);
                let quoted = quote(&author, &text);
                conversation(&format!("{quoted}\n\n{}", draft.body))
            }
            other => other,
        };
    }
    let (Some(path), Some(line)) = (&draft.path, draft.line) else {
        return conversation(&draft.body);
    };
    let head = pr_head_oid(gh, cwd, number)?;
    // The line numbers are the worktree's: they only mean the same lines on
    // the PR when its head is the commit they were made on.
    if draft.commit.as_deref() != Some(head.as_str()) {
        return Err(GitError::PrHeadMismatch);
    }
    let mut body = serde_json::json!({
        "body": draft.body,
        "commit_id": head,
        "path": path,
        "line": line,
        "side": "RIGHT",
    });
    if let Some(start) = draft.start_line.filter(|s| *s != line) {
        body["line"] = start.max(line).into();
        body["start_line"] = start.min(line).into();
        body["start_side"] = "RIGHT".into();
    }
    post_json(
        gh,
        cwd,
        &format!("repos/{repo}/pulls/{number}/comments"),
        &body,
    )
}

/// The head commit of PR `number` on GitHub.
pub fn pr_head_oid(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<String, GitError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Head {
        head_ref_oid: String,
    }
    let out = ok(gh.run(
        cwd,
        &["pr", "view", &number.to_string(), "--json", "headRefOid"],
        None,
    )?)?;
    let head: Head = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    Ok(head.head_ref_oid)
}

/// The author and body of review comment `id`, for the quote of a reply that
/// became a conversation comment. A failed read gives a bare quote.
fn replied_comment(gh: &dyn GhExec, cwd: &Path, repo: &str, id: u64) -> (String, String) {
    #[derive(Deserialize)]
    struct User {
        login: String,
    }
    #[derive(Deserialize)]
    struct Raw {
        user: Option<User>,
        #[serde(default)]
        body: String,
    }
    let endpoint = format!("repos/{repo}/pulls/comments/{id}");
    let raw = gh
        .run(cwd, &["api", &endpoint], None)
        .ok()
        .filter(|o| o.status == Some(0))
        .and_then(|o| serde_json::from_str::<Raw>(&o.stdout).ok());
    match raw {
        Some(r) => (r.user.map_or_else(|| "ghost".into(), |u| u.login), r.body),
        None => ("ghost".into(), String::new()),
    }
}

/// Resolves or unresolves a review thread by its GraphQL id.
pub fn pr_thread_resolve(
    gh: &dyn GhExec,
    cwd: &Path,
    thread_id: &str,
    resolved: bool,
) -> Result<(), GitError> {
    let name = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    let query =
        format!("mutation($id: ID!) {{ {name}(input: {{threadId: $id}}) {{ thread {{ id }} }} }}");
    ok(gh.run(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-f",
            &format!("id={thread_id}"),
        ],
        None,
    )?)?;
    Ok(())
}

/// Adds or removes the signed-in login's reaction on a comment or review.
pub fn pr_reaction(
    gh: &dyn GhExec,
    cwd: &Path,
    subject_id: &str,
    content: Reaction,
    on: bool,
) -> Result<(), GitError> {
    let name = if on { "addReaction" } else { "removeReaction" };
    let query = format!(
        "mutation($id: ID!, $content: ReactionContent!) {{ {name}(input: {{subjectId: $id, content: $content}}) {{ reaction {{ content }} }} }}"
    );
    ok(gh.run(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-f",
            &format!("id={subject_id}"),
            "-f",
            &format!("content={}", content.as_str()),
        ],
        None,
    )?)?;
    Ok(())
}

/// Reruns the Actions runs behind the checks of PR `number`: the failed or
/// cancelled ones with `failed_only` (and `gh run rerun --failed`), else every
/// run. A run behind several checks is rerun once; checks without an Actions
/// run are counted as skipped.
pub fn pr_checks_rerun(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    failed_only: bool,
) -> Result<RerunReport, GitError> {
    let checks = pr_checks(gh, cwd, number)?;
    let mut ids: Vec<String> = Vec::new();
    let mut skipped = 0;
    for check in &checks {
        let wanted =
            !failed_only || matches!(check.bucket, CheckBucket::Fail | CheckBucket::Cancel);
        if !wanted {
            continue;
        }
        match check.link.as_deref().and_then(run_id) {
            Some(id) if ids.iter().any(|seen| seen == id) => {}
            Some(id) => ids.push(id.to_owned()),
            None => skipped += 1,
        }
    }
    if ids.is_empty() {
        return Err(GitError::NothingToRerun);
    }
    let mut started = 0;
    for id in &ids {
        let mut args = vec!["run", "rerun", id.as_str()];
        if failed_only {
            args.push("--failed");
        }
        if let Err(e) = gh.run(cwd, &args, None).and_then(ok) {
            return Err(match (started, e) {
                (k, GitError::Gh(msg)) if k > 0 => {
                    GitError::Gh(format!("{msg} ({k} reruns already started)"))
                }
                (_, e) => e,
            });
        }
        started += 1;
    }
    Ok(RerunReport { started, skipped })
}

/// Whether a pull request can be merged from here, and with which methods.
pub fn pr_merge_info(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<PrMergeInfo, GitError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pr {
        #[serde(default)]
        state: String,
        #[serde(default)]
        is_draft: bool,
        #[serde(default)]
        merge_state_status: String,
        #[serde(default)]
        review_decision: Option<String>,
        #[serde(default)]
        status_check_rollup: Vec<Rollup>,
    }
    #[derive(Deserialize)]
    struct Rollup {
        #[serde(default)]
        conclusion: Option<String>,
        #[serde(default)]
        state: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Repo {
        #[serde(default)]
        viewer_default_merge_method: String,
        #[serde(default)]
        squash_merge_allowed: bool,
        #[serde(default)]
        merge_commit_allowed: bool,
        #[serde(default)]
        rebase_merge_allowed: bool,
    }
    let pr_out = ok(gh.run(
        cwd,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup",
        ],
        None,
    )?)?;
    let pr: Pr = serde_json::from_str(&pr_out.stdout).map_err(parse_error)?;
    let repo_out = ok(gh.run(
        cwd,
        &[
            "repo",
            "view",
            "--json",
            "viewerDefaultMergeMethod,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
        ],
        None,
    )?)?;
    let repo: Repo = serde_json::from_str(&repo_out.stdout).map_err(parse_error)?;

    let review = pr.review_decision.as_deref().unwrap_or("");
    let block = match (pr.state.as_str(), pr.merge_state_status.as_str()) {
        ("MERGED", _) => Some(MergeBlock::Merged),
        ("CLOSED", _) => Some(MergeBlock::Closed),
        _ if pr.is_draft => Some(MergeBlock::Draft),
        _ if review == "REVIEW_REQUIRED" => Some(MergeBlock::ReviewRequired),
        _ if review == "CHANGES_REQUESTED" => Some(MergeBlock::ChangesRequested),
        (_, "DIRTY") => Some(MergeBlock::Conflicts),
        (_, "UNKNOWN") => Some(MergeBlock::Unknown),
        (_, "BEHIND") => Some(MergeBlock::Behind),
        (_, "BLOCKED") => Some(MergeBlock::Blocked),
        _ => None,
    };
    let checks_failed = pr.status_check_rollup.iter().any(|r| {
        [r.conclusion.as_deref(), r.state.as_deref()]
            .into_iter()
            .flatten()
            .any(|v| matches!(v, "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE"))
    });
    let methods: Vec<MergeMethod> = [
        (repo.squash_merge_allowed, MergeMethod::Squash),
        (repo.merge_commit_allowed, MergeMethod::Merge),
        (repo.rebase_merge_allowed, MergeMethod::Rebase),
    ]
    .into_iter()
    .filter_map(|(allowed, m)| allowed.then_some(m))
    .collect();
    let preferred = match repo.viewer_default_merge_method.as_str() {
        "MERGE" => MergeMethod::Merge,
        "REBASE" => MergeMethod::Rebase,
        _ => MergeMethod::Squash,
    };
    let default_method = if methods.contains(&preferred) {
        preferred
    } else {
        methods.first().copied().unwrap_or(MergeMethod::Squash)
    };
    Ok(PrMergeInfo {
        block,
        checks_failed,
        methods,
        default_method,
    })
}

/// The block a refused merge names, from `gh`'s message.
fn merge_refusal(text: &str) -> Option<MergeBlock> {
    let t = text.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    if has(&["already merged"]) {
        Some(MergeBlock::Merged)
    } else if has(&["is closed", "already closed"]) {
        Some(MergeBlock::Closed)
    } else if has(&["draft"]) {
        Some(MergeBlock::Draft)
    } else if has(&["merge queue"]) {
        Some(MergeBlock::MergeQueue)
    } else if has(&["changes requested", "requested changes"]) {
        Some(MergeBlock::ChangesRequested)
    } else if has(&["review is required", "approving review", "required review"]) {
        Some(MergeBlock::ReviewRequired)
    } else if has(&["conflict"]) {
        Some(MergeBlock::Conflicts)
    } else if has(&["behind", "out-of-date", "out of date"]) {
        Some(MergeBlock::Behind)
    } else if has(&[
        "policy prohibits",
        "status check",
        "protected branch",
        "not mergeable",
    ]) {
        Some(MergeBlock::Blocked)
    } else {
        None
    }
}

/// Merges PR `number` with `method`. The branch is left alone (no
/// `--delete-branch`). A refusal is mapped to `MergeBlocked`.
pub fn pr_merge(
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
    let out = gh.run(cwd, &["pr", "merge", &number.to_string(), flag], None)?;
    if out.status == Some(0) {
        return Ok(());
    }
    match classify(&out) {
        GitError::Gh(text) => {
            Err(merge_refusal(&text).map_or(GitError::Gh(text), GitError::MergeBlocked))
        }
        other => Err(other),
    }
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

    const REPO: &str = r#"{"nameWithOwner":"acme/app"}"#;

    fn read(json: &str) -> Result<PrComments, GitError> {
        let fake = Fake::new(vec![out(0, REPO, ""), out(0, json, "")]);
        pr_comments(&fake, cwd(), 7)
    }

    #[test]
    fn pr_comments_passes_owner_name_and_a_typed_number() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(0, include_str!("../fixtures/pr_comments.json"), ""),
        ]);
        pr_comments(&fake, cwd(), 7).unwrap();
        let calls = fake.calls.borrow();
        let args = &calls[1].0;
        assert_eq!(&args[..3], ["api", "graphql", "-f"]);
        assert!(args[3].starts_with("query="));
        assert_eq!(
            args[4..],
            ["-f", "owner=acme", "-f", "name=app", "-F", "number=7"]
        );
        assert_eq!(calls[1].1, None);
    }

    #[test]
    fn pr_comments_maps_threads_and_sorts_oldest_first() {
        let got = read(include_str!("../fixtures/pr_comments.json")).unwrap();
        assert!(!got.truncated);
        let ids: Vec<u64> = got.comments.iter().map(|c| c.id).collect();
        // Review 302 (empty) and 303 (HTML comments only) are dropped.
        assert_eq!(ids, [103, 201, 101, 102, 301, 104, 105]);
        let by = |id: u64| got.comments.iter().find(|c| c.id == id).unwrap();
        let root = by(101);
        assert_eq!(root.kind, PrCommentKind::Thread);
        assert_eq!((root.line, root.start_line), (Some(12), Some(10)));
        assert_eq!(root.thread_id.as_deref(), Some("T_open"));
        assert_eq!(root.reply_to, None);
        assert_eq!(root.diff_hunk.as_deref(), Some("@@ hunk A"));
        assert_eq!(
            root.reactions,
            [PrReaction {
                content: Reaction::ThumbsUp,
                count: 2,
                mine: true
            }]
        );
        let reply = by(102);
        assert_eq!(reply.reply_to, Some(101));
        assert_eq!(reply.diff_hunk, None);
        assert!(by(103).resolved);
        assert_eq!(by(201).kind, PrCommentKind::Conversation);
        assert_eq!(by(301).kind, PrCommentKind::Review);
        assert_eq!(by(301).node_id, "R1");
    }

    #[test]
    fn pr_comments_marks_outdated_ghost_bot_and_left_side() {
        let got = read(include_str!("../fixtures/pr_comments.json")).unwrap();
        let by = |id: u64| got.comments.iter().find(|c| c.id == id).unwrap();
        let old = by(104);
        assert!(old.outdated);
        assert_eq!((old.line, old.start_line), (Some(7), Some(5)));
        assert_eq!(old.author, "ghost");
        assert!(!old.author_bot);
        let left = by(105);
        assert!(left.author_bot);
        assert_eq!(left.diff_hunk, None);
        assert!(!by(101).outdated);
    }

    #[test]
    fn pr_comments_flags_a_full_source_as_truncated() {
        let node = r#"{"id":"I","databaseId":1,"body":"x","createdAt":"2026-11-02T08:00:00Z","url":"u","author":null,"reactionGroups":[]}"#;
        let many = vec![node; COMMENTS_PER_SOURCE].join(",");
        let json = format!(
            r#"{{"data":{{"repository":{{"pullRequest":{{"reviewThreads":{{"nodes":[]}},"comments":{{"nodes":[{many}]}},"reviews":{{"nodes":[]}}}}}}}}}}"#
        );
        let got = read(&json).unwrap();
        assert!(got.truncated);
        assert_eq!(got.comments.len(), COMMENTS_PER_SOURCE);
    }

    fn page_json(page: &str, comments_page: &str) -> String {
        let node = |id: u32| {
            format!(
                r#"{{"id":"I{id}","databaseId":{id},"body":"b{id}","createdAt":"2026-11-02T08:{:02}:{:02}Z","url":"u","author":null,"reactionGroups":[]}}"#,
                id / 60,
                id % 60
            )
        };
        // The newest 100 of 150 conversation comments: 51 to 150.
        let many = (51..=150).map(node).collect::<Vec<_>>().join(",");
        let thread = format!(
            r#"{{"id":"T","isResolved":false,"line":1,"path":"a.rs","comments":{{"pageInfo":{{"hasNextPage":{comments_page}}},"nodes":[{}]}}}}"#,
            node(1)
        );
        format!(
            r#"{{"data":{{"repository":{{"pullRequest":{{"reviewThreads":{{"pageInfo":{{"hasPreviousPage":false}},"nodes":[{thread}]}},"comments":{{"pageInfo":{{"hasPreviousPage":{page}}},"nodes":[{many}]}},"reviews":{{"pageInfo":{{"hasPreviousPage":false}},"nodes":[]}}}}}}}}}}"#
        )
    }

    #[test]
    fn pr_comments_asks_for_the_newest_of_each_source() {
        let fake = Fake::new(vec![out(0, REPO, ""), out(0, &page_json("false", "false"), "")]);
        pr_comments(&fake, cwd(), 7).unwrap();
        let query = fake.calls.borrow()[1].0[3].clone();
        for source in ["reviewThreads", "comments", "reviews"] {
            assert!(
                query.contains(&format!("{source}(last: 100)")),
                "{source} must read the newest 100"
            );
        }
        assert!(query.contains("hasPreviousPage") && query.contains("hasNextPage"));
    }

    #[test]
    fn pr_comments_keeps_the_newest_page_and_flags_the_older_ones() {
        let got = read(&page_json("true", "false")).unwrap();
        assert!(got.truncated);
        let conversation: Vec<u64> = got
            .comments
            .iter()
            .filter(|c| c.kind == PrCommentKind::Conversation)
            .map(|c| c.id)
            .collect();
        assert_eq!(conversation.len(), 100);
        assert_eq!(conversation.first(), Some(&51));
        assert_eq!(conversation.last(), Some(&150));
        // A full page that says nothing is behind it is complete.
        assert!(!read(&page_json("false", "false")).unwrap().truncated);
    }

    #[test]
    fn pr_comments_flags_a_thread_with_more_replies_than_one_page() {
        assert!(read(&page_json("false", "true")).unwrap().truncated);
    }

    #[test]
    fn pr_comments_keeps_data_beside_errors() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(
                1,
                include_str!("../fixtures/pr_comments_partial.json"),
                "gh: error",
            ),
        ]);
        let got = pr_comments(&fake, cwd(), 7).unwrap();
        assert_eq!(got.comments.len(), 1);
        assert_eq!(got.comments[0].body, "Still here");
    }

    #[test]
    fn pr_comments_classifies_a_failed_call() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(
                1,
                "",
                "To get started with GitHub CLI, please run:  gh auth login",
            ),
        ]);
        assert_eq!(pr_comments(&fake, cwd(), 7).unwrap_err().code(), "gh_auth");
        let fake = Fake::new(vec![out(0, REPO, ""), out(1, "", "boom")]);
        assert_eq!(
            pr_comments(&fake, cwd(), 7).unwrap_err().code(),
            "gh_failed"
        );
        let fake = Fake::new(vec![out(1, "", "none of the git remotes")]);
        assert_eq!(
            pr_comments(&fake, cwd(), 7).unwrap_err().code(),
            "not_github"
        );
    }

    #[test]
    fn pr_comments_cuts_a_long_body() {
        let long = "é".repeat(COMMENT_BODY_MAX + 5);
        let json = format!(
            r#"{{"data":{{"repository":{{"pullRequest":{{"reviewThreads":{{"nodes":[]}},"comments":{{"nodes":[{{"id":"I","databaseId":1,"body":"{long}","createdAt":"t","url":"u","author":null}}]}},"reviews":{{"nodes":[]}}}}}}}}}}"#
        );
        let got = read(&json).unwrap();
        assert_eq!(got.comments[0].body.chars().count(), COMMENT_BODY_MAX);
    }

    fn draft(body: &str) -> PrCommentDraft {
        PrCommentDraft {
            body: body.into(),
            reply_to: None,
            path: None,
            line: None,
            start_line: None,
            commit: None,
        }
    }

    fn json_of(call: &Call) -> serde_json::Value {
        serde_json::from_str(call.1.as_deref().expect("stdin")).unwrap()
    }

    #[test]
    fn a_conversation_comment_goes_on_stdin_never_argv() {
        let fake = Fake::new(vec![out(0, REPO, ""), out(0, "{}", "")]);
        let body = "Xin chào \"thế giới\"\r\nline 2 🚀";
        pr_comment_post(&fake, cwd(), 7, &draft(body)).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(
            calls[1].0,
            [
                "api",
                "--method",
                "POST",
                "repos/acme/app/issues/7/comments",
                "--input",
                "-"
            ]
        );
        assert!(
            calls
                .iter()
                .all(|c| c.0.iter().all(|a| !a.contains("thế giới")))
        );
        assert_eq!(json_of(&calls[1]), serde_json::json!({ "body": body }));
    }

    #[test]
    fn an_empty_or_huge_body_never_reaches_gh() {
        let fake = Fake::new(vec![]);
        let err = pr_comment_post(&fake, cwd(), 7, &draft("  \n ")).unwrap_err();
        assert_eq!(err.code(), "empty_comment");
        let huge = "x".repeat(COMMENT_BODY_MAX + 1);
        let err = pr_comment_post(&fake, cwd(), 7, &draft(&huge)).unwrap_err();
        assert_eq!(err.code(), "comment_too_large");
        assert!(fake.calls.borrow().is_empty());
        let max = "x".repeat(COMMENT_BODY_MAX);
        let fake = Fake::new(vec![out(0, REPO, ""), out(0, "{}", "")]);
        pr_comment_post(&fake, cwd(), 7, &draft(&max)).unwrap();
    }

    #[test]
    fn a_reply_posts_to_the_thread() {
        let fake = Fake::new(vec![out(0, REPO, ""), out(0, "{}", "")]);
        let d = PrCommentDraft {
            reply_to: Some(101),
            ..draft("ok")
        };
        pr_comment_post(&fake, cwd(), 7, &d).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[1].0[3], "repos/acme/app/pulls/7/comments/101/replies");
        assert_eq!(json_of(&calls[1]), serde_json::json!({ "body": "ok" }));
    }

    #[test]
    fn a_refused_reply_becomes_a_quoting_conversation_comment() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(1, "", "gh: Unprocessable Entity (HTTP 422)"),
            out(
                0,
                r#"{"user":{"login":"maya"},"body":"First line\nsecond"}"#,
                "",
            ),
            out(0, "{}", ""),
        ]);
        let d = PrCommentDraft {
            reply_to: Some(101),
            ..draft("Fixed")
        };
        pr_comment_post(&fake, cwd(), 7, &d).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[2].0, ["api", "repos/acme/app/pulls/comments/101"]);
        assert_eq!(calls[3].0[3], "repos/acme/app/issues/7/comments");
        let body = json_of(&calls[3]);
        assert_eq!(body["body"], "> @maya: First line\n\nFixed");
    }

    #[test]
    fn another_reply_failure_is_not_swallowed() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(1, "", "gh: Server Error (HTTP 500)"),
        ]);
        let d = PrCommentDraft {
            reply_to: Some(101),
            ..draft("x")
        };
        assert_eq!(
            pr_comment_post(&fake, cwd(), 7, &d).unwrap_err().code(),
            "gh_failed"
        );
    }

    #[test]
    fn an_inline_comment_reads_the_head_first() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(0, r#"{"headRefOid":"abc123"}"#, ""),
            out(0, "{}", ""),
        ]);
        let d = PrCommentDraft {
            path: Some("src/a.rs".into()),
            line: Some(10),
            commit: Some("abc123".into()),
            ..draft("note")
        };
        pr_comment_post(&fake, cwd(), 7, &d).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[1].0, ["pr", "view", "7", "--json", "headRefOid"]);
        assert_eq!(calls[2].0[3], "repos/acme/app/pulls/7/comments");
        assert_eq!(
            json_of(&calls[2]),
            serde_json::json!({ "body": "note", "commit_id": "abc123", "path": "src/a.rs", "line": 10, "side": "RIGHT" })
        );
    }

    #[test]
    fn an_inline_comment_on_another_commit_is_refused() {
        for commit in [Some("def456".to_owned()), None] {
            let fake = Fake::new(vec![out(0, REPO, ""), out(0, r#"{"headRefOid":"abc123"}"#, "")]);
            let d = PrCommentDraft {
                path: Some("src/a.rs".into()),
                line: Some(10),
                commit,
                ..draft("note")
            };
            let err = pr_comment_post(&fake, cwd(), 7, &d).unwrap_err();
            assert_eq!(err.code(), "pr_head_mismatch");
            // Nothing was posted: repo name and head only.
            assert_eq!(fake.calls.borrow().len(), 2);
        }
    }

    #[test]
    fn pr_head_oid_reads_the_head_commit() {
        let fake = Fake::new(vec![out(0, r#"{"headRefOid":"abc123"}"#, "")]);
        assert_eq!(pr_head_oid(&fake, cwd(), 7).unwrap(), "abc123");
        assert_eq!(
            fake.calls.borrow()[0].0,
            ["pr", "view", "7", "--json", "headRefOid"]
        );
    }

    #[test]
    fn an_inline_range_adds_start_line_only_when_it_differs() {
        let run = |start: Option<u32>| {
            let fake = Fake::new(vec![
                out(0, REPO, ""),
                out(0, r#"{"headRefOid":"abc"}"#, ""),
                out(0, "{}", ""),
            ]);
            let d = PrCommentDraft {
                path: Some("a.rs".into()),
                line: Some(10),
                start_line: start,
                commit: Some("abc".into()),
                ..draft("n")
            };
            pr_comment_post(&fake, cwd(), 7, &d).unwrap();
            let calls = fake.calls.borrow();
            json_of(&calls[2])
        };
        let same = run(Some(10));
        assert!(same.get("start_line").is_none() && same.get("start_side").is_none());
        let range = run(Some(6));
        assert_eq!(range["start_line"], 6);
        assert_eq!(range["start_side"], "RIGHT");
        assert_eq!(range["line"], 10);
    }

    #[test]
    fn resolve_and_unresolve_use_their_mutations() {
        let fake = Fake::new(vec![out(0, "{}", ""), out(0, "{}", "")]);
        pr_thread_resolve(&fake, cwd(), "T_1", true).unwrap();
        pr_thread_resolve(&fake, cwd(), "T_1", false).unwrap();
        let calls = fake.calls.borrow();
        assert!(
            calls[0].0[3].contains("resolveReviewThread(") && !calls[0].0[3].contains("unresolve")
        );
        assert!(calls[1].0[3].contains("unresolveReviewThread("));
        assert_eq!(calls[0].0[4..], ["-f", "id=T_1"]);
        let fake = Fake::new(vec![out(1, "", "boom")]);
        assert_eq!(
            pr_thread_resolve(&fake, cwd(), "T", true)
                .unwrap_err()
                .code(),
            "gh_failed"
        );
    }

    #[test]
    fn reactions_use_add_remove_and_the_enum_spelling() {
        let fake = Fake::new(vec![out(0, "{}", ""), out(0, "{}", "")]);
        pr_reaction(&fake, cwd(), "N_1", Reaction::ThumbsUp, true).unwrap();
        pr_reaction(&fake, cwd(), "N_1", Reaction::Hooray, false).unwrap();
        let calls = fake.calls.borrow();
        assert!(calls[0].0[3].contains("addReaction("));
        assert!(calls[1].0[3].contains("removeReaction("));
        assert_eq!(calls[0].0[4..], ["-f", "id=N_1", "-f", "content=THUMBS_UP"]);
        assert_eq!(calls[1].0[7], "content=HOORAY");
    }

    #[test]
    fn wire_names_match_the_contract() {
        let r = serde_json::to_string(&Reaction::ThumbsUp).unwrap();
        assert_eq!(r, r#""THUMBS_UP""#);
        assert_eq!(Reaction::ThumbsUp.as_str(), "THUMBS_UP");
        let b = serde_json::to_string(&MergeBlock::ChangesRequested).unwrap();
        assert_eq!(b, format!("\"{}\"", MergeBlock::ChangesRequested.as_str()));
        let m: MergeMethod = serde_json::from_str(r#""squash""#).unwrap();
        assert_eq!(m, MergeMethod::Squash);
        let d: PrCommentDraft = serde_json::from_str(
            r#"{"body":"x","replyTo":5,"path":null,"line":null,"startLine":null}"#,
        )
        .unwrap();
        assert_eq!(d.reply_to, Some(5));
    }

    fn checks_json(rows: &[(&str, &str, &str)]) -> String {
        let items: Vec<String> = rows
            .iter()
            .map(|(name, bucket, link)| {
                format!(
                    r#"{{"name":"{name}","state":"X","bucket":"{bucket}","link":"{link}","workflow":"CI"}}"#
                )
            })
            .collect();
        format!("[{}]", items.join(","))
    }

    const RUN1: &str = "https://github.com/acme/app/actions/runs/111/job/1";
    const RUN1B: &str = "https://github.com/acme/app/actions/runs/111/job/2";
    const RUN2: &str = "https://github.com/acme/app/actions/runs/222/job/3";
    const RUN3: &str = "https://github.com/acme/app/actions/runs/333/job/4";
    const EXT: &str = "https://ci.example/9";

    #[test]
    fn rerun_starts_each_failed_run_once_with_failed_flag() {
        let json = checks_json(&[
            ("a", "fail", RUN1),
            ("b", "cancel", RUN1B),
            ("c", "fail", RUN2),
            ("d", "pass", RUN3),
        ]);
        let fake = Fake::new(vec![out(0, &json, ""), out(0, "", ""), out(0, "", "")]);
        let got = pr_checks_rerun(&fake, cwd(), 7, true).unwrap();
        assert_eq!(
            got,
            RerunReport {
                started: 2,
                skipped: 0
            }
        );
        let calls = fake.calls.borrow();
        assert_eq!(calls[1].0, ["run", "rerun", "111", "--failed"]);
        assert_eq!(calls[2].0, ["run", "rerun", "222", "--failed"]);
    }

    #[test]
    fn rerun_all_omits_the_failed_flag_and_covers_every_bucket() {
        let json = checks_json(&[("a", "pass", RUN1), ("b", "fail", RUN2)]);
        let fake = Fake::new(vec![out(0, &json, ""), out(0, "", ""), out(0, "", "")]);
        let got = pr_checks_rerun(&fake, cwd(), 7, false).unwrap();
        assert_eq!(got.started, 2);
        let calls = fake.calls.borrow();
        assert_eq!(calls[1].0, ["run", "rerun", "111"]);
        assert_eq!(calls[2].0, ["run", "rerun", "222"]);
    }

    #[test]
    fn rerun_counts_checks_without_an_actions_run_as_skipped() {
        let json = checks_json(&[("a", "fail", RUN1), ("ci/ext", "fail", EXT)]);
        let fake = Fake::new(vec![out(0, &json, ""), out(0, "", "")]);
        let got = pr_checks_rerun(&fake, cwd(), 7, true).unwrap();
        assert_eq!(
            got,
            RerunReport {
                started: 1,
                skipped: 1
            }
        );
    }

    #[test]
    fn rerun_with_nothing_to_rerun_is_an_error() {
        let json = checks_json(&[("a", "pass", RUN1), ("ci/ext", "fail", EXT)]);
        let fake = Fake::new(vec![out(0, &json, "")]);
        assert!(matches!(
            pr_checks_rerun(&fake, cwd(), 7, true),
            Err(GitError::NothingToRerun)
        ));
        assert_eq!(fake.calls.borrow().len(), 1);
    }

    #[test]
    fn rerun_failure_after_a_start_reports_how_many_started() {
        let json = checks_json(&[("a", "fail", RUN1), ("c", "fail", RUN2)]);
        let fake = Fake::new(vec![out(0, &json, ""), out(0, "", ""), out(1, "", "boom")]);
        match pr_checks_rerun(&fake, cwd(), 7, true) {
            Err(GitError::Gh(m)) => assert_eq!(m, "boom (1 reruns already started)"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rerun_failure_on_the_first_run_keeps_the_plain_message() {
        let json = checks_json(&[("a", "fail", RUN1)]);
        let fake = Fake::new(vec![out(0, &json, ""), out(1, "", "boom")]);
        match pr_checks_rerun(&fake, cwd(), 7, true) {
            Err(GitError::Gh(m)) => assert_eq!(m, "boom"),
            other => panic!("{other:?}"),
        }
    }

    fn pr_json(
        state: &str,
        draft: bool,
        merge_state: &str,
        review: Option<&str>,
        rollup: &str,
    ) -> String {
        let review = review.map_or("null".to_owned(), |r| format!("\"{r}\""));
        format!(
            r#"{{"state":"{state}","isDraft":{draft},"mergeable":"MERGEABLE","mergeStateStatus":"{merge_state}","reviewDecision":{review},"statusCheckRollup":{rollup}}}"#
        )
    }

    fn repo_json(default: &str, squash: bool, merge: bool, rebase: bool) -> String {
        format!(
            r#"{{"viewerDefaultMergeMethod":"{default}","squashMergeAllowed":{squash},"mergeCommitAllowed":{merge},"rebaseMergeAllowed":{rebase}}}"#
        )
    }

    fn info(pr: &str, repo: &str) -> PrMergeInfo {
        let fake = Fake::new(vec![out(0, pr, ""), out(0, repo, "")]);
        pr_merge_info(&fake, cwd(), 7).unwrap()
    }

    #[test]
    fn merge_info_blocks_in_order() {
        let r = repo_json("SQUASH", true, true, true);
        let block =
            |state, draft, ms, review| info(&pr_json(state, draft, ms, review, "[]"), &r).block;
        assert_eq!(
            block("MERGED", true, "DIRTY", Some("CHANGES_REQUESTED")),
            Some(MergeBlock::Merged)
        );
        assert_eq!(
            block("CLOSED", true, "CLEAN", None),
            Some(MergeBlock::Closed)
        );
        assert_eq!(
            block("OPEN", true, "DIRTY", Some("REVIEW_REQUIRED")),
            Some(MergeBlock::Draft)
        );
        assert_eq!(
            block("OPEN", false, "DIRTY", Some("REVIEW_REQUIRED")),
            Some(MergeBlock::ReviewRequired)
        );
        assert_eq!(
            block("OPEN", false, "DIRTY", Some("CHANGES_REQUESTED")),
            Some(MergeBlock::ChangesRequested)
        );
        assert_eq!(
            block("OPEN", false, "DIRTY", Some("APPROVED")),
            Some(MergeBlock::Conflicts)
        );
        assert_eq!(
            block("OPEN", false, "UNKNOWN", None),
            Some(MergeBlock::Unknown)
        );
        assert_eq!(
            block("OPEN", false, "BEHIND", None),
            Some(MergeBlock::Behind)
        );
        assert_eq!(
            block("OPEN", false, "BLOCKED", Some("APPROVED")),
            Some(MergeBlock::Blocked)
        );
        assert_eq!(block("OPEN", false, "CLEAN", Some("APPROVED")), None);
        assert_eq!(block("OPEN", false, "UNSTABLE", None), None);
        assert_eq!(block("OPEN", false, "HAS_HOOKS", None), None);
    }

    #[test]
    fn merge_info_reads_failed_checks_from_conclusion_or_state() {
        let r = repo_json("SQUASH", true, false, false);
        let pr = |rollup: &str| pr_json("OPEN", false, "CLEAN", None, rollup);
        assert!(!info(&pr(r#"[{"conclusion":"SUCCESS"},{"state":"SUCCESS"}]"#), &r).checks_failed);
        assert!(info(&pr(r#"[{"conclusion":"FAILURE"}]"#), &r).checks_failed);
        assert!(info(&pr(r#"[{"state":"ERROR"}]"#), &r).checks_failed);
        assert!(!info(&pr("[]"), &r).checks_failed);
    }

    #[test]
    fn merge_info_lists_allowed_methods_and_falls_back_on_the_default() {
        let pr = pr_json("OPEN", false, "CLEAN", None, "[]");
        let got = info(&pr, &repo_json("REBASE", true, true, true));
        assert_eq!(
            got.methods,
            [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase]
        );
        assert_eq!(got.default_method, MergeMethod::Rebase);
        let got = info(&pr, &repo_json("SQUASH", false, true, true));
        assert_eq!(got.methods, [MergeMethod::Merge, MergeMethod::Rebase]);
        assert_eq!(got.default_method, MergeMethod::Merge);
        let got = info(&pr, &repo_json("", false, false, false));
        assert!(got.methods.is_empty());
        assert_eq!(got.default_method, MergeMethod::Squash);
    }

    #[test]
    fn merge_info_asks_gh_for_the_documented_fields() {
        let fake = Fake::new(vec![
            out(0, &pr_json("OPEN", false, "CLEAN", None, "[]"), ""),
            out(0, &repo_json("SQUASH", true, true, true), ""),
        ]);
        pr_merge_info(&fake, cwd(), 7).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(
            calls[0].0,
            [
                "pr",
                "view",
                "7",
                "--json",
                "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"
            ]
        );
        assert_eq!(&calls[1].0[..2], ["repo", "view"]);
    }

    #[test]
    fn merge_uses_the_method_flag_and_never_deletes_the_branch() {
        for (method, flag) in [
            (MergeMethod::Squash, "--squash"),
            (MergeMethod::Merge, "--merge"),
            (MergeMethod::Rebase, "--rebase"),
        ] {
            let fake = Fake::new(vec![out(0, "", "")]);
            pr_merge(&fake, cwd(), 7, method).unwrap();
            assert_eq!(fake.calls.borrow()[0].0, ["pr", "merge", "7", flag]);
        }
    }

    #[test]
    fn merge_refusals_map_to_blocks() {
        let cases = [
            ("Pull request is a draft", MergeBlock::Draft),
            (
                "Pull request is not mergeable: merge conflict",
                MergeBlock::Conflicts,
            ),
            (
                "the base branch policy prohibits the merge",
                MergeBlock::Blocked,
            ),
            (
                "At least 1 approving review is required",
                MergeBlock::ReviewRequired,
            ),
            ("Head branch is out of date", MergeBlock::Behind),
            ("Pull request #7 was already merged", MergeBlock::Merged),
        ];
        for (stderr, want) in cases {
            let fake = Fake::new(vec![out(1, "", stderr)]);
            match pr_merge(&fake, cwd(), 7, MergeMethod::Squash) {
                Err(GitError::MergeBlocked(b)) => assert_eq!(b, want, "{stderr}"),
                other => panic!("{stderr}: {other:?}"),
            }
        }
    }

    #[test]
    fn merge_failures_without_a_known_reason_stay_gh_errors() {
        let fake = Fake::new(vec![out(1, "", "network down")]);
        assert!(matches!(
            pr_merge(&fake, cwd(), 7, MergeMethod::Squash),
            Err(GitError::Gh(m)) if m == "network down"
        ));
        let fake = Fake::new(vec![out(1, "", "run gh auth login")]);
        assert!(matches!(
            pr_merge(&fake, cwd(), 7, MergeMethod::Squash),
            Err(GitError::GhAuth)
        ));
    }
}
