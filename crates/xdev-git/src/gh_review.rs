//! Review on a pull request through `gh`: comments, threads, reactions,
//! check reruns and merge. Every call goes through `GhExec`, so a test runs
//! no `gh`. Bodies go on stdin, never in argv.

use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;

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
