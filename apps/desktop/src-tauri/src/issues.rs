//! GitHub issues of a registered repo, read through `gh` in its main checkout.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::State;
use xdev_git::{
    GhAccount, GhExec, GitError, Issue, IssueDetail, IssueDraft, IssueEdit, IssueEditReport,
    IssueEvent, IssueLabel, IssueQuery, SystemGh, issue_assignable as gh_issue_assignable,
    issue_comment as gh_issue_comment, issue_create as gh_issue_create,
    issue_edit as gh_issue_edit, issue_labels as gh_issue_labels, issue_list, issue_open_web,
    issue_timeline as gh_issue_timeline, issue_view as gh_issue_view, parse_issue_ref, repo_name,
};
use xdev_workspace::{Registry, WorkspaceError};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::ship::run_gh;

/// `owner/repo` by repo id, asked of `gh` once per process.
pub(crate) fn names() -> &'static Mutex<HashMap<String, String>> {
    static NAMES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    NAMES.get_or_init(Mutex::default)
}

/// The repo's main checkout, where `gh` finds its remote.
pub(crate) fn main_path(data: &Path, repo_id: &str) -> Result<PathBuf, CmdError> {
    let reg = Registry::load(data)?;
    reg.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| r.path.clone())
        .ok_or_else(|| WorkspaceError::RepoUnknown(repo_id.to_owned()).into())
}

/// The `gh` login the repo is bound to, if any.
pub(crate) fn account_of(data: &Path, repo_id: &str) -> Result<Option<GhAccount>, CmdError> {
    let reg = Registry::load(data)?;
    reg.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| r.gh_account.clone())
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

fn create_issue_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    draft: &IssueDraft,
) -> Result<Issue, CmdError> {
    Ok(gh_issue_create(gh, &main_path(data, repo_id)?, draft)?)
}

fn edit_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
    edit: &IssueEdit,
) -> Result<IssueEditReport, CmdError> {
    Ok(gh_issue_edit(gh, &main_path(data, repo_id)?, number, edit)?)
}

fn comment_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
    body: &str,
) -> Result<(), CmdError> {
    Ok(gh_issue_comment(
        gh,
        &main_path(data, repo_id)?,
        number,
        body,
    )?)
}

fn labels_with(gh: &dyn GhExec, data: &Path, repo_id: &str) -> Result<Vec<IssueLabel>, CmdError> {
    Ok(gh_issue_labels(gh, &main_path(data, repo_id)?)?)
}

fn assignable_with(gh: &dyn GhExec, data: &Path, repo_id: &str) -> Result<Vec<String>, CmdError> {
    Ok(gh_issue_assignable(gh, &main_path(data, repo_id)?)?)
}

fn timeline_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
) -> Result<Vec<IssueEvent>, CmdError> {
    Ok(gh_issue_timeline(gh, &main_path(data, repo_id)?, number)?)
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
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        list_with(gh, data, &repo_id, &query)
    })
}

#[tauri::command(async)]
pub fn issue_view(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<IssueDetail, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        view_with(gh, data, &repo_id, number)
    })
}

#[tauri::command(async)]
pub fn issue_open(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        open_with(gh, data, &repo_id, number)
    })
}

/// Makes an issue from a title and a body and returns it as `gh` stored it.
#[tauri::command(async)]
pub fn issue_create(
    state: State<'_, AppState>,
    repo_id: String,
    draft: IssueDraft,
) -> Result<Issue, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        create_issue_with(gh, data, &repo_id, &draft)
    })
}

/// Changes an issue's state, labels, assignees, title or body. Every part is
/// tried; the report names the parts that failed.
#[tauri::command(async)]
pub fn issue_edit(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
    edit: IssueEdit,
) -> Result<IssueEditReport, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        edit_with(gh, data, &repo_id, number, &edit)
    })
}

/// Posts a comment on an issue.
#[tauri::command(async)]
pub fn issue_comment(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
    body: String,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        comment_with(gh, data, &repo_id, number, &body)
    })
}

/// The repo's labels.
#[tauri::command(async)]
pub fn issue_labels(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<IssueLabel>, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| labels_with(gh, data, &repo_id))
}

/// Logins an issue of the repo can be assigned to.
#[tauri::command(async)]
pub fn issue_assignable(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<String>, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| assignable_with(gh, data, &repo_id))
}

/// An issue's events, oldest first.
#[tauri::command(async)]
pub fn issue_timeline(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<Vec<IssueEvent>, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        timeline_with(gh, data, &repo_id, number)
    })
}

/// Parses `text` and reads the issue; an issue URL of another repo is
/// refused with `issue_other_repo`, and text that names no issue gives `None`.
#[tauri::command(async)]
pub fn issue_resolve(
    state: State<'_, AppState>,
    repo_id: String,
    text: String,
) -> Result<Option<Issue>, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        resolve_with(gh, data, &repo_id, &text)
    })
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
    fn account_of_reads_the_repos_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let mut reg = Registry::load(tmp.path()).unwrap();
        reg.repos.push(xdev_workspace::RepoEntry {
            id: "r".into(),
            gh_account: Some(GhAccount {
                host: "github.com".into(),
                user: "u".into(),
            }),
            ..xdev_workspace::RepoEntry::default()
        });
        reg.repos.push(xdev_workspace::RepoEntry {
            id: "plain".into(),
            ..xdev_workspace::RepoEntry::default()
        });
        reg.save(tmp.path()).unwrap();
        assert_eq!(account_of(tmp.path(), "r").unwrap().unwrap().user, "u");
        assert_eq!(account_of(tmp.path(), "plain").unwrap(), None);
        assert_eq!(
            account_of(tmp.path(), "nope").unwrap_err().code,
            "repo_unknown"
        );
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
    fn create_runs_in_the_main_checkout_with_the_body_on_stdin() {
        let (_tmp, data) = fixture("r-new");
        let fake = Fake::new(vec![
            (
                0,
                "https://github.com/acme/app/issues/5
",
                "",
            ),
            (0, ISSUE, ""),
        ]);
        let draft = IssueDraft {
            title: "T".into(),
            body: "b".into(),
        };
        let issue = create_issue_with(&fake, &data, "r-new", &draft).unwrap();
        assert_eq!(issue.number, 5);
        assert_eq!(fake.calls.borrow()[0][..3], ["issue", "create", "--title"]);
        let blank = IssueDraft {
            title: " ".into(),
            body: String::new(),
        };
        let err = create_issue_with(&fake, &data, "r-new", &blank).unwrap_err();
        assert_eq!(err.code, "bad_draft");
    }

    #[test]
    fn open_runs_the_web_view_in_the_main_checkout() {
        let (_tmp, data) = fixture("r-open");
        let fake = Fake::new(vec![(0, "", "")]);
        open_with(&fake, &data, "r-open", 3).unwrap();
        assert_eq!(fake.calls.borrow()[0], ["issue", "view", "3", "--web"]);
    }

    #[test]
    fn edit_with_runs_in_main_checkout() {
        let (_tmp, data) = fixture("r-edit");
        let fake = Fake::new(vec![(0, "", "")]);
        let edit = IssueEdit {
            add_labels: vec!["bug".into()],
            ..IssueEdit::default()
        };
        let report = edit_with(&fake, &data, "r-edit", 5, &edit).unwrap();
        assert!(report.failed.is_empty());
        assert_eq!(fake.calls.borrow()[0][..3], ["issue", "edit", "5"]);
        let bad = IssueEdit {
            add_labels: vec!["-x".into()],
            ..IssueEdit::default()
        };
        assert_eq!(
            edit_with(&fake, &data, "r-edit", 5, &bad).unwrap_err().code,
            "bad_draft"
        );
    }

    #[test]
    fn comment_with_maps_empty_comment() {
        let (_tmp, data) = fixture("r-comment");
        let fake = Fake::new(vec![]);
        let err = comment_with(&fake, &data, "r-comment", 5, "  ").unwrap_err();
        assert_eq!(err.code, "empty_comment");
        let big = "x".repeat(xdev_git::COMMENT_BODY_MAX + 1);
        let err = comment_with(&fake, &data, "r-comment", 5, &big).unwrap_err();
        assert_eq!(err.code, "comment_too_large");
    }

    #[test]
    fn labels_and_assignable_run_in_the_main_checkout() {
        let (_tmp, data) = fixture("r-pick");
        let fake = Fake::new(vec![
            (0, r#"[{"name":"bug","color":"f00"}]"#, ""),
            (0, r#"{"nameWithOwner":"acme/app"}"#, ""),
            (
                0, "octo
", "",
            ),
        ]);
        assert_eq!(labels_with(&fake, &data, "r-pick").unwrap()[0].name, "bug");
        assert_eq!(assignable_with(&fake, &data, "r-pick").unwrap(), ["octo"]);
    }

    #[test]
    fn timeline_with_maps_not_github() {
        let (_tmp, data) = fixture("r-time");
        let fake = Fake::new(vec![(
            1,
            "",
            "none of the git remotes configured for this repository point to a known GitHub host",
        )]);
        let err = timeline_with(&fake, &data, "r-time", 5).unwrap_err();
        assert_eq!(err.code, "not_github");
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
