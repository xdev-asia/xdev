//! Changes to a pull request through `gh`: its title and body, reviewers
//! asked or no longer asked, and the logins that can be asked. Every call goes
//! through `GhExec`, so a test runs no `gh`. A reviewer is checked before it
//! reaches argv; a body only ever goes on stdin.

use std::path::Path;

use crate::gh::{GhExec, ok};
use crate::{GitError, PR_TEXT_MAX};

/// Longest GitHub login.
const LOGIN_MAX: usize = 39;
/// Longest team slug kept; GitHub's own limit is higher than any real slug.
const TEAM_MAX: usize = 100;
/// Longest title, as for a new pull request.
const TITLE_MAX: usize = 256;

fn login_ok(s: &str) -> bool {
    (1..=LOGIN_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !s.starts_with('-')
}

/// A login (`ada`) or a team (`org/team`). Anything else never reaches `gh`.
pub fn valid_reviewer(name: &str) -> bool {
    match name.split_once('/') {
        Some((org, team)) => {
            login_ok(org)
                && (1..=TEAM_MAX).contains(&team.len())
                && team
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                && !team.starts_with('-')
        }
        None => login_ok(name),
    }
}

/// Sets the title (trimmed, 1 to 256 chars) and the body (at most
/// `PR_TEXT_MAX` chars, on stdin) of pull request `number`.
pub fn pr_edit(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    title: &str,
    body: &str,
) -> Result<(), GitError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX || body.chars().count() > PR_TEXT_MAX {
        return Err(GitError::BadPrEdit);
    }
    let n = number.to_string();
    // `--title=` so a title that starts with `-` is still a value.
    let title = format!("--title={title}");
    ok(gh.run(
        cwd,
        &["pr", "edit", &n, &title, "--body-file", "-"],
        Some(body),
    )?)?;
    Ok(())
}

/// Asks `add` for a review and drops the request of `remove`, in one
/// `gh pr edit`. Nothing to change runs no `gh`.
pub fn pr_reviewers_edit(
    gh: &dyn GhExec,
    cwd: &Path,
    number: u64,
    add: &[String],
    remove: &[String],
) -> Result<(), GitError> {
    if let Some(bad) = add.iter().chain(remove).find(|r| !valid_reviewer(r)) {
        return Err(GitError::BadReviewer(bad.clone()));
    }
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }
    let n = number.to_string();
    // `--flag=value`, so a value is never read as a flag of its own.
    let adds = format!("--add-reviewer={}", add.join(","));
    let removes = format!("--remove-reviewer={}", remove.join(","));
    let mut args = vec!["pr", "edit", n.as_str()];
    if !add.is_empty() {
        args.push(&adds);
    }
    if !remove.is_empty() {
        args.push(&removes);
    }
    ok(gh.run(cwd, &args, None)?)?;
    Ok(())
}

/// The collaborators of the repo, the logins a review is usually asked of.
/// `{owner}/{repo}` is filled in by `gh` from the repo of `cwd`; `--jq` prints
/// one login per line however many pages there are.
pub fn pr_reviewer_candidates(gh: &dyn GhExec, cwd: &Path) -> Result<Vec<String>, GitError> {
    let out = ok(gh.run(
        cwd,
        &[
            "api",
            "repos/{owner}/{repo}/collaborators",
            "--paginate",
            "--jq",
            ".[].login",
        ],
        None,
    )?)?;
    Ok(out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| login_ok(l))
        .map(str::to_owned)
        .collect())
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

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn edit_sends_the_title_as_one_value_and_the_body_on_stdin() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_edit(&fake, cwd(), 12, "  --web fix  ", "line\n--title=x\n").unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(
            calls[0].0,
            ["pr", "edit", "12", "--title=--web fix", "--body-file", "-"]
        );
        assert_eq!(calls[0].1.as_deref(), Some("line\n--title=x\n"));
    }

    #[test]
    fn edit_takes_an_empty_body_and_refuses_a_bad_title_or_long_body() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_edit(&fake, cwd(), 1, "Fix", "").unwrap();
        assert_eq!(fake.calls.borrow()[0].1.as_deref(), Some(""));
        for (title, body) in [
            ("   ", String::new()),
            (&*"x".repeat(TITLE_MAX + 1), String::new()),
            ("Fix", "x".repeat(PR_TEXT_MAX + 1)),
        ] {
            assert!(matches!(
                pr_edit(&fake, cwd(), 1, title, &body),
                Err(GitError::BadPrEdit)
            ));
        }
        assert_eq!(fake.calls.borrow().len(), 1);
        // The limit counts chars, not bytes.
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_edit(&fake, cwd(), 1, &"é".repeat(TITLE_MAX), "").unwrap();
    }

    #[test]
    fn edit_surfaces_a_gh_failure() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "GraphQL: Resource not accessible by integration",
        )]);
        assert!(matches!(
            pr_edit(&fake, cwd(), 1, "Fix", "b"),
            Err(GitError::Gh(_))
        ));
    }

    #[test]
    fn reviewer_names_are_logins_or_teams() {
        for good in [
            "ada",
            "a-b",
            "A1",
            &"x".repeat(39),
            "acme/core",
            "acme/web_team",
        ] {
            assert!(valid_reviewer(good), "{good}");
        }
        for bad in [
            "",
            "-ada",
            &"x".repeat(40),
            "a b",
            "ada,bob",
            "ada\n",
            "a_b",
            "acme/",
            "/core",
            "acme/-x",
            "acme/core/x",
            "--add-reviewer",
            "ádа",
        ] {
            assert!(!valid_reviewer(bad), "{bad:?}");
        }
    }

    #[test]
    fn reviewers_go_in_one_edit_with_joined_flags() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_reviewers_edit(
            &fake,
            cwd(),
            42,
            &names(&["ada", "acme/core"]),
            &names(&["bob"]),
        )
        .unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(
            calls[0].0,
            [
                "pr",
                "edit",
                "42",
                "--add-reviewer=ada,acme/core",
                "--remove-reviewer=bob"
            ]
        );
        assert_eq!(calls[0].1, None);
    }

    #[test]
    fn reviewers_only_remove_passes_one_flag() {
        let fake = Fake::new(vec![out(0, "", "")]);
        pr_reviewers_edit(&fake, cwd(), 7, &[], &names(&["bob"])).unwrap();
        assert_eq!(
            fake.calls.borrow()[0].0,
            ["pr", "edit", "7", "--remove-reviewer=bob"]
        );
    }

    #[test]
    fn reviewers_refuse_a_bad_name_before_running_gh() {
        let fake = Fake::new(vec![]);
        let err = pr_reviewers_edit(&fake, cwd(), 1, &names(&["ok", "--web"]), &[]).unwrap_err();
        assert!(matches!(err, GitError::BadReviewer(n) if n == "--web"));
        let err = pr_reviewers_edit(&fake, cwd(), 1, &[], &names(&["a,b"])).unwrap_err();
        assert!(matches!(err, GitError::BadReviewer(_)));
        assert!(pr_reviewers_edit(&fake, cwd(), 1, &[], &[]).is_ok());
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn reviewers_surface_a_scope_or_gh_failure() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "error: your authentication token is missing required scopes [read:org]",
        )]);
        let err = pr_reviewers_edit(&fake, cwd(), 1, &names(&["acme/core"]), &[]).unwrap_err();
        assert!(matches!(err, GitError::GhScope(_)));
        let fake = Fake::new(vec![out(1, "", "'zed' not found")]);
        let err = pr_reviewers_edit(&fake, cwd(), 1, &names(&["zed"]), &[]).unwrap_err();
        assert!(matches!(err, GitError::Gh(t) if t.contains("zed")));
    }

    #[test]
    fn candidates_read_the_collaborators_one_per_line() {
        let fake = Fake::new(vec![out(0, "ada\nbob\n\n  cy \nnot a login\n", "")]);
        let got = pr_reviewer_candidates(&fake, cwd()).unwrap();
        assert_eq!(got, ["ada", "bob", "cy"]);
        assert_eq!(
            fake.calls.borrow()[0].0,
            [
                "api",
                "repos/{owner}/{repo}/collaborators",
                "--paginate",
                "--jq",
                ".[].login"
            ]
        );
    }

    #[test]
    fn candidates_fail_when_the_list_is_closed() {
        let fake = Fake::new(vec![out(
            1,
            "",
            "gh: Must have push access to view repository collaborators. (HTTP 403)",
        )]);
        assert!(matches!(
            pr_reviewer_candidates(&fake, cwd()),
            Err(GitError::Gh(_))
        ));
    }
}
