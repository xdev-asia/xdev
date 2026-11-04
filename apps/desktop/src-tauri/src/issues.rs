//! GitHub issues of a registered repo, read through `gh` in its main checkout.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::State;
use xdev_git::{
    GhExec, GitError, Issue, IssueDetail, IssueQuery, SystemGh, issue_list, issue_open_web,
    issue_view as gh_issue_view, parse_issue_ref, repo_name,
};
use xdev_workspace::{Registry, WorkspaceError};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

/// `owner/repo` by repo id, asked of `gh` once per process.
fn names() -> &'static Mutex<HashMap<String, String>> {
    static NAMES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    NAMES.get_or_init(Mutex::default)
}

/// The repo's main checkout, where `gh` finds its remote.
fn main_path(data: &Path, repo_id: &str) -> Result<PathBuf, CmdError> {
    let reg = Registry::load(data)?;
    reg.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| r.path.clone())
        .ok_or_else(|| WorkspaceError::RepoUnknown(repo_id.to_owned()).into())
}

fn list_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    query: &IssueQuery,
) -> Result<Vec<Issue>, CmdError> {
    Ok(issue_list(gh, &main_path(data, repo_id)?, query)?)
}

fn view_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
) -> Result<IssueDetail, CmdError> {
    Ok(gh_issue_view(gh, &main_path(data, repo_id)?, number)?)
}

fn open_with(gh: &dyn GhExec, data: &Path, repo_id: &str, number: u64) -> Result<(), CmdError> {
    Ok(issue_open_web(gh, &main_path(data, repo_id)?, number)?)
}

fn resolve_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    text: &str,
) -> Result<Option<Issue>, CmdError> {
    let Some((owner_repo, number)) = parse_issue_ref(text) else {
        return Ok(None);
    };
    let cwd = main_path(data, repo_id)?;
    if let Some(wanted) = owner_repo {
        let cached = names().lock().unwrap().get(repo_id).cloned();
        let own = match cached {
            Some(name) => name,
            None => {
                let name = repo_name(gh, &cwd)?;
                names()
                    .lock()
                    .unwrap()
                    .insert(repo_id.to_owned(), name.clone());
                name
            }
        };
        if !own.eq_ignore_ascii_case(&wanted) {
            return Err(GitError::IssueOtherRepo(wanted).into());
        }
    }
    match gh_issue_view(gh, &cwd, number) {
        Ok(detail) => Ok(Some(detail.issue)),
        Err(GitError::IssueNotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command(async)]
pub fn issues_list(
    state: State<'_, AppState>,
    repo_id: String,
    query: IssueQuery,
) -> Result<Vec<Issue>, CmdError> {
    list_with(&SystemGh, data_dir(&state)?, &repo_id, &query)
}

#[tauri::command(async)]
pub fn issue_view(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<IssueDetail, CmdError> {
    view_with(&SystemGh, data_dir(&state)?, &repo_id, number)
}

#[tauri::command(async)]
pub fn issue_open(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<(), CmdError> {
    open_with(&SystemGh, data_dir(&state)?, &repo_id, number)
}

/// Parses `text` and reads the issue; an issue URL of another repo is
/// refused with `issue_other_repo`, and text that names no issue gives `None`.
#[tauri::command(async)]
pub fn issue_resolve(
    state: State<'_, AppState>,
    repo_id: String,
    text: String,
) -> Result<Option<Issue>, CmdError> {
    resolve_with(&SystemGh, data_dir(&state)?, &repo_id, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use xdev_git::GhOutput;
    use xdev_workspace::RepoEntry;

    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        script: RefCell<VecDeque<GhOutput>>,
    }

    impl Fake {
        fn new(script: Vec<(i32, &str, &str)>) -> Fake {
            Fake {
                calls: RefCell::default(),
                script: RefCell::new(
                    script
                        .into_iter()
                        .map(|(status, stdout, stderr)| GhOutput {
                            status: Some(status),
                            stdout: stdout.into(),
                            stderr: stderr.into(),
                        })
                        .collect(),
                ),
            }
        }
    }

    impl GhExec for Fake {
        fn run(&self, cwd: &Path, args: &[&str], _: Option<&str>) -> Result<GhOutput, GitError> {
            assert!(cwd.ends_with("main"), "runs in the main checkout: {cwd:?}");
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            Ok(self.script.borrow_mut().pop_front().expect("scripted"))
        }
    }

    const ISSUE: &str = r#"{"number":5,"url":"https://github.com/acme/app/issues/5","state":"OPEN","title":"T","labels":[],"assignees":[],"author":null,"updatedAt":"x","body":"","comments":[]}"#;

    /// A data dir whose registry holds one repo with the given id.
    fn fixture(id: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = crate::test_dirs::long_temp_dir("issues cmd ");
        let data = tmp.path().join("data");
        let main = tmp.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        let mut reg = Registry::load(&data).unwrap();
        reg.repos.push(RepoEntry {
            id: id.into(),
            path: main,
            ..RepoEntry::default()
        });
        reg.save(&data).unwrap();
        (tmp, data)
    }

    #[test]
    fn list_and_view_run_in_the_main_checkout() {
        let (_tmp, data) = fixture("r-list");
        let fake = Fake::new(vec![(0, "[]", ""), (0, ISSUE, "")]);
        assert!(
            list_with(&fake, &data, "r-list", &IssueQuery::default())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            view_with(&fake, &data, "r-list", 5).unwrap().issue.number,
            5
        );
        assert_eq!(fake.calls.borrow()[1][..3], ["issue", "view", "5"]);
    }

    #[test]
    fn open_runs_the_web_view_in_the_main_checkout() {
        let (_tmp, data) = fixture("r-open");
        let fake = Fake::new(vec![(0, "", "")]);
        open_with(&fake, &data, "r-open", 3).unwrap();
        assert_eq!(fake.calls.borrow()[0], ["issue", "view", "3", "--web"]);
    }

    #[test]
    fn unknown_repo_is_refused() {
        let (_tmp, data) = fixture("r-known");
        let fake = Fake::new(vec![]);
        let err = list_with(&fake, &data, "nope", &IssueQuery::default()).unwrap_err();
        assert_eq!(err.code, "repo_unknown");
    }

    #[test]
    fn resolve_reads_a_number_and_gives_none_for_junk() {
        let (_tmp, data) = fixture("r-num");
        let fake = Fake::new(vec![(0, ISSUE, "")]);
        assert_eq!(resolve_with(&fake, &data, "r-num", "hello").unwrap(), None);
        let issue = resolve_with(&fake, &data, "r-num", " #5 ")
            .unwrap()
            .unwrap();
        assert_eq!(issue.number, 5);
        assert_eq!(fake.calls.borrow().len(), 1, "no repo lookup for a number");
    }

    #[test]
    fn resolve_not_found_is_none() {
        let (_tmp, data) = fixture("r-nf");
        let fake = Fake::new(vec![(
            1,
            "",
            "Could not resolve to an issue or pull request",
        )]);
        assert_eq!(resolve_with(&fake, &data, "r-nf", "#9").unwrap(), None);
    }

    #[test]
    fn resolve_url_checks_the_repo_once() {
        let (_tmp, data) = fixture("r-url");
        let fake = Fake::new(vec![
            (0, r#"{"nameWithOwner":"acme/app"}"#, ""),
            (0, ISSUE, ""),
            (0, ISSUE, ""),
        ]);
        let url = "https://github.com/Acme/App/issues/5";
        assert!(resolve_with(&fake, &data, "r-url", url).unwrap().is_some());
        assert!(resolve_with(&fake, &data, "r-url", url).unwrap().is_some());
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 3, "repo view only the first time");
        assert_eq!(calls[0][0], "repo");
    }

    #[test]
    fn resolve_refuses_another_repo() {
        let (_tmp, data) = fixture("r-other");
        let fake = Fake::new(vec![(0, r#"{"nameWithOwner":"acme/app"}"#, "")]);
        let err = resolve_with(
            &fake,
            &data,
            "r-other",
            "https://github.com/other/thing/issues/5",
        )
        .unwrap_err();
        assert_eq!(err.code, "issue_other_repo");
    }
}
