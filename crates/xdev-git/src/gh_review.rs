//! Review on a pull request through `gh`: comments, threads, reactions,
//! check reruns and merge. Every call goes through `GhExec`, so a test runs
//! no `gh`. Bodies go on stdin, never in argv.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{GhExec, ok, parse_error, repo_name};

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
    /// A source hit `COMMENTS_PER_SOURCE`, so more may exist.
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
      reviewThreads(first: 100) { nodes {
        id isResolved line originalLine startLine originalStartLine path diffSide
        comments(first: 100) { nodes {
          id databaseId body createdAt url diffHunk
          author { login __typename } replyTo { databaseId } ...R } } } }
      comments(first: 100) { nodes {
        id databaseId body createdAt url author { login __typename } ...R } }
      reviews(first: 100) { nodes {
        id databaseId body submittedAt url author { login __typename } ...R } }
    }
  }
}
"#;

#[derive(Deserialize)]
struct Nodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
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

/// Every comment of the PR, oldest first, from one GraphQL call. A partial
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
    let truncated = pull.review_threads.nodes.len() >= COMMENTS_PER_SOURCE
        || pull.comments.nodes.len() >= COMMENTS_PER_SOURCE
        || pull.reviews.nodes.len() >= COMMENTS_PER_SOURCE;
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
    let out = ok(gh.run(
        cwd,
        &["pr", "view", &number.to_string(), "--json", "headRefOid"],
        None,
    )?)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Head {
        head_ref_oid: String,
    }
    let head: Head = serde_json::from_str(&out.stdout).map_err(parse_error)?;
    let mut body = serde_json::json!({
        "body": draft.body,
        "commit_id": head.head_ref_oid,
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
}
