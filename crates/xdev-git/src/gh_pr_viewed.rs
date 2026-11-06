//! Which files of a pull request the signed-in login marked viewed, and the
//! mark itself, through `gh api graphql`. Every call goes through `GhExec`, so
//! a test runs no `gh`; values reach GraphQL as variables, never in the query.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{GhExec, ok, repo_name};

const VIEWED_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } } } } }";
/// GitHub lists at most 3000 files of a pull request; 30 pages of 100.
const PAGES_MAX: usize = 30;

/// The node id of a pull request, which the mark needs, and the paths the
/// signed-in login marked viewed. A file changed since it was marked is not
/// viewed any more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrViewed {
    pub id: String,
    pub viewed: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    path: String,
    viewer_viewed_state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPage {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFiles {
    nodes: Vec<RawFile>,
    page_info: RawPage,
}

#[derive(Deserialize)]
struct RawPull {
    id: String,
    files: Option<RawFiles>,
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

/// The viewed files of pull request `number`, page by page.
pub fn pr_viewed_files(gh: &dyn GhExec, cwd: &Path, number: u64) -> Result<PrViewed, GitError> {
    let repo = repo_name(gh, cwd)?;
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| GitError::Gh(format!("unexpected repo name: {repo}")))?;
    let query = format!("query={VIEWED_QUERY}");
    let owner = format!("owner={owner}");
    let name = format!("name={name}");
    let number = format!("number={number}");
    let mut id = None;
    let mut viewed = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let cursor = after.as_ref().map(|c| format!("after={c}"));
        let mut args = vec![
            "api", "graphql", "-f", &query, "-f", &owner, "-f", &name, "-F", &number,
        ];
        if let Some(c) = &cursor {
            args.extend(["-f", c.as_str()]);
        }
        let out = gh.run(cwd, &args, None)?;
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
        let files = pull
            .files
            .ok_or_else(|| GitError::Gh("unexpected gh output: no files".into()))?;
        id = Some(pull.id);
        viewed.extend(
            files
                .nodes
                .into_iter()
                .filter(|f| f.viewer_viewed_state.as_deref() == Some("VIEWED"))
                .map(|f| f.path),
        );
        match files.page_info {
            RawPage {
                has_next_page: true,
                end_cursor: Some(c),
            } => after = Some(c),
            _ => break,
        }
    }
    let id = id.ok_or(GitError::PrNotFound)?;
    Ok(PrViewed { id, viewed })
}

/// A GraphQL node id: letters, digits, `_`, `-` and `=` padding.
fn node_id_ok(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'='))
}

/// Marks `path` of the pull request with node id `pr_id` viewed, or not.
pub fn pr_file_viewed(
    gh: &dyn GhExec,
    cwd: &Path,
    pr_id: &str,
    path: &str,
    viewed: bool,
) -> Result<(), GitError> {
    if !node_id_ok(pr_id) {
        return Err(GitError::Gh(format!("not a pull request id: {pr_id}")));
    }
    if path.is_empty() || path.contains(['\n', '\r', '\0']) {
        return Err(GitError::Gh(format!("not a file path: {path:?}")));
    }
    let name = if viewed {
        "markFileAsViewed"
    } else {
        "unmarkFileAsViewed"
    };
    let query = format!(
        "mutation($id: ID!, $path: String!) {{ {name}(input: {{pullRequestId: $id, path: $path}}) {{ clientMutationId }} }}"
    );
    ok(gh.run(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-f",
            &format!("id={pr_id}"),
            "-f",
            &format!("path={path}"),
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

    fn page(files: &[(&str, &str)], next: Option<&str>) -> String {
        let nodes: Vec<String> = files
            .iter()
            .map(|(p, s)| format!(r#"{{"path":"{p}","viewerViewedState":"{s}"}}"#))
            .collect();
        let info = match next {
            Some(c) => format!(r#"{{"hasNextPage":true,"endCursor":"{c}"}}"#),
            None => r#"{"hasNextPage":false,"endCursor":null}"#.to_owned(),
        };
        format!(
            r#"{{"data":{{"repository":{{"pullRequest":{{"id":"PR_kw1","files":{{"nodes":[{}],"pageInfo":{info}}}}}}}}}}}"#,
            nodes.join(",")
        )
    }

    #[test]
    fn viewed_reads_every_page_and_keeps_only_viewed() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(
                0,
                &page(&[("a.rs", "VIEWED"), ("b.rs", "UNVIEWED")], Some("c1")),
                "",
            ),
            out(
                0,
                &page(&[("c.rs", "DISMISSED"), ("d.rs", "VIEWED")], None),
                "",
            ),
        ]);
        let got = pr_viewed_files(&fake, cwd(), 5).unwrap();
        assert_eq!(
            got,
            PrViewed {
                id: "PR_kw1".into(),
                viewed: vec!["a.rs".into(), "d.rs".into()],
            }
        );
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, ["repo", "view", "--json", "nameWithOwner"]);
        assert_eq!(&calls[1].0[..2], ["api", "graphql"]);
        assert!(calls[1].0.contains(&"owner=acme".to_owned()));
        assert!(calls[1].0.contains(&"name=app".to_owned()));
        assert!(calls[1].0.contains(&"number=5".to_owned()));
        assert!(!calls[1].0.iter().any(|a| a.starts_with("after=")));
        assert_eq!(calls[2].0.last().unwrap(), "after=c1");
    }

    #[test]
    fn viewed_of_a_missing_pr_or_a_closed_repo_fails() {
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(
                1,
                r#"{"data":{"repository":{"pullRequest":null}},"errors":[{"message":"Could not resolve"}]}"#,
                "gh: Could not resolve",
            ),
        ]);
        assert!(matches!(
            pr_viewed_files(&fake, cwd(), 5),
            Err(GitError::Gh(_))
        ));
        let fake = Fake::new(vec![
            out(0, REPO, ""),
            out(0, r#"{"data":{"repository":{"pullRequest":null}}}"#, ""),
        ]);
        assert!(matches!(
            pr_viewed_files(&fake, cwd(), 5),
            Err(GitError::PrNotFound)
        ));
        let fake = Fake::new(vec![out(
            1,
            "",
            "To get started with GitHub CLI, please run:  gh auth login",
        )]);
        assert!(matches!(
            pr_viewed_files(&fake, cwd(), 5),
            Err(GitError::GhAuth)
        ));
    }

    #[test]
    fn mark_and_unmark_pass_id_and_path_as_variables() {
        let fake = Fake::new(vec![out(0, "{}", ""), out(0, "{}", "")]);
        pr_file_viewed(&fake, cwd(), "PR_kw1==", "src/a b.rs", true).unwrap();
        pr_file_viewed(&fake, cwd(), "PR_kw1==", "src/a b.rs", false).unwrap();
        let calls = fake.calls.borrow();
        assert!(calls[0].0[3].contains("markFileAsViewed(input:"));
        assert!(!calls[0].0[3].contains("src/a"));
        assert!(calls[1].0[3].contains("unmarkFileAsViewed(input:"));
        assert_eq!(
            calls[0].0[4..],
            ["-f", "id=PR_kw1==", "-f", "path=src/a b.rs"]
        );
    }

    #[test]
    fn mark_refuses_a_bad_id_or_path_before_running_gh() {
        let fake = Fake::new(vec![]);
        for (id, path) in [
            ("", "a.rs"),
            ("PR 1", "a.rs"),
            ("PR\"}", "a.rs"),
            ("PR_1", ""),
            ("PR_1", "a\nb"),
            ("PR_1", "a\0b"),
        ] {
            assert!(pr_file_viewed(&fake, cwd(), id, path, true).is_err());
        }
        assert!(fake.calls.borrow().is_empty());
    }
}
