//! The template language of the agent recipes: `{name}` is replaced from a
//! list of values, everything else is left as written.

/// What a commit message template can name.
pub const COMMIT_VARS: [&str; 5] = [
    "basePrompt",
    "branch",
    "stagedFiles",
    "stagedPatch",
    "linkedIssue",
];

/// What a pull request template can name.
pub const PR_VARS: [&str; 9] = [
    "basePrompt",
    "branch",
    "baseBranch",
    "currentTitle",
    "currentBody",
    "commitSummary",
    "changedFiles",
    "patch",
    "linkedIssue",
];

/// `template` with each `{name}` that `vars` lists replaced by its value.
/// An unknown `{name}` stays as written; `{{` and `}}` are the braces
/// themselves; a value is never expanded again.
pub fn render(template: &str, vars: &[(&str, &str)]) -> String {
    // The renderer arrives with the tests of B2.
    let _ = vars;
    template.to_owned()
}
