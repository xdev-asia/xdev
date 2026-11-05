//! Review on a pull request through `gh`: comments, threads, reactions,
//! check reruns and merge. Every call goes through `GhExec`, so a test runs
//! no `gh`. Bodies go on stdin, never in argv.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{GhExec, ok, repo_name};

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
