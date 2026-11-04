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
/// themselves; a value is never expanded again. The TypeScript renderer
/// (`settings/recipes/render.ts`) follows the same rules and the same
/// fixture.
pub fn render(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find(['{', '}']) {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if rest.starts_with("{{") {
            out.push('{');
            rest = &rest[2..];
        } else if rest.starts_with("}}") {
            out.push('}');
            rest = &rest[2..];
        } else if let Some((name, after)) = variable(rest)
            && let Some((_, value)) = vars.iter().find(|(n, _)| *n == name)
        {
            out.push_str(value);
            rest = after;
        } else {
            // A lone brace, or a name nobody gave: written as it is.
            out.push_str(&rest[..1]);
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// The name and the text after it, for text that starts with `{name}`.
fn variable(text: &str) -> Option<(&str, &str)> {
    let inner = text.strip_prefix('{')?;
    let end = inner.find('}')?;
    let name = &inner[..end];
    let word = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    word.then(|| (name, &inner[end + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        template: String,
        vars: std::collections::BTreeMap<String, String>,
        expected: String,
    }

    #[test]
    fn render_follows_the_shared_table() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/recipes.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let vars: Vec<(&str, &str)> = case
                .vars
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            assert_eq!(
                render(&case.template, &vars),
                case.expected,
                "{}",
                case.name
            );
        }
    }
}
