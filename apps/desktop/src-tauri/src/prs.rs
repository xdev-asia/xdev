//! Pull requests and Projects of a registered repo, read through `gh` in its
//! main checkout, and the local branch a pull request is started on.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::State;
use xdev_git::{
    GhExec, PrQuery, PrSummary, ProjectSummary, Repo, SystemGh, pr_get as gh_pr_get, pr_list,
    pr_open_number, project_list, project_open as gh_project_open, repo_name,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::issues::{account_of, main_path, names};
use crate::ship::run_gh;

fn list_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    query: &PrQuery,
) -> Result<Vec<PrSummary>, CmdError> {
    Ok(pr_list(gh, &main_path(data, repo_id)?, query)?)
}

fn get_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
) -> Result<PrSummary, CmdError> {
    Ok(gh_pr_get(gh, &main_path(data, repo_id)?, number)?)
}

fn open_with(gh: &dyn GhExec, data: &Path, repo_id: &str, number: u64) -> Result<(), CmdError> {
    Ok(pr_open_number(gh, &main_path(data, repo_id)?, number)?)
}

/// The owner of the repo's GitHub name, asked of `gh` once per repo.
fn owner_of(gh: &dyn GhExec, repo_id: &str, cwd: &Path) -> Result<String, CmdError> {
    let cached = names().lock().unwrap().get(repo_id).cloned();
    let full = match cached {
        Some(name) => name,
        None => {
            let name = repo_name(gh, cwd)?;
            names()
                .lock()
                .unwrap()
                .insert(repo_id.to_owned(), name.clone());
            name
        }
    };
    Ok(full.split('/').next().unwrap_or_default().to_owned())
}

fn projects_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
) -> Result<Vec<ProjectSummary>, CmdError> {
    let cwd = main_path(data, repo_id)?;
    let owner = owner_of(gh, repo_id, &cwd)?;
    Ok(project_list(gh, &cwd, &owner)?)
}

fn project_open_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
) -> Result<(), CmdError> {
    let cwd = main_path(data, repo_id)?;
    let owner = owner_of(gh, repo_id, &cwd)?;
    Ok(gh_project_open(gh, &cwd, &owner, number)?)
}

/// `(repo id, branch)` of the branches `branch_with` made by fetching, with the tip they had
/// then. Only a branch still at that tip may be discarded, so neither a branch the user had nor
/// one the user committed on or re-created is ever deleted.
fn made() -> &'static Mutex<HashMap<(String, String), String>> {
    static MADE: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    MADE.get_or_init(Mutex::default)
}

fn made_key(repo_id: &str, branch: &str) -> (String, String) {
    (repo_id.to_owned(), branch.to_owned())
}

/// Records `branch` as fetched, with the commit it points at now.
fn made_insert(repo: &Repo, repo_id: &str, branch: &str) -> Result<(), CmdError> {
    let Some(tip) = repo.resolve_ref(&format!("refs/heads/{branch}"))? else {
        // The fetch said it made the branch but it is not there: record nothing.
        return Err(xdev_git::GitError::Failed {
            args: "rev-parse".into(),
            status: None,
            stderr: format!("the fetched branch {branch} cannot be resolved"),
        }
        .into());
    };
    made()
        .lock()
        .unwrap()
        .insert(made_key(repo_id, branch), tip);
    Ok(())
}

/// The branch `pr_branch` chose, and whether it was fetched for this call (so the caller may
/// take it back) or already existed.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PrBranch {
    pub branch: String,
    pub fetched: bool,
}

/// Deletes `branch` when `branch_with` made it, it still has the fetched tip and no worktree
/// has it; says whether it did. Anything else is left alone.
fn discard_with(data: &Path, repo_id: &str, branch: &str) -> Result<bool, CmdError> {
    let Some(tip) = made().lock().unwrap().remove(&made_key(repo_id, branch)) else {
        return Ok(false);
    };
    let repo = Repo::discover(&main_path(data, repo_id)?)?;
    if repo
        .resolve_ref(&format!("refs/heads/{branch}"))?
        .as_deref()
        != Some(tip.as_str())
    {
        return Ok(false);
    }
    if repo
        .list_worktrees()?
        .iter()
        .any(|w| w.branch.as_deref() == Some(branch))
    {
        return Ok(false);
    }
    repo.delete_branch(branch)?;
    Ok(true)
}

/// The local branch to start pull request `number` on, fetched when needed:
/// - not a fork, `head` exists locally: `head`, nothing fetched;
/// - not a fork, `head` free: fetched into `head`;
/// - a fork: fetched into `pr-<n>`, or `pr-<n>-2`, … when that is taken.
///
/// A branch checked out in a worktree is refused with `branch_in_use`. A local
/// branch is never moved: git refuses a fetch that is not a fast-forward.
fn branch_with(
    gh: &dyn GhExec,
    data: &Path,
    repo_id: &str,
    number: u64,
) -> Result<PrBranch, CmdError> {
    let cwd = main_path(data, repo_id)?;
    let pr = gh_pr_get(gh, &cwd, number)?;
    branch_for(
        data,
        repo_id,
        &pr.head,
        pr.fork,
        "pr",
        number,
        &|repo, branch| repo.fetch_pull(number, branch),
    )
}

/// The branch rules of `branch_with` for any change request: `head` is its source branch, `fork`
/// says it lives in another repo, `prefix` names a fork's branch (`<prefix>-<n>`) and `fetch`
/// puts the request's head into a local branch.
pub(crate) fn branch_for(
    data: &Path,
    repo_id: &str,
    head: &str,
    fork: bool,
    prefix: &str,
    number: u64,
    fetch: &dyn Fn(&Repo, &str) -> Result<(), xdev_git::GitError>,
) -> Result<PrBranch, CmdError> {
    let cwd = main_path(data, repo_id)?;
    let repo = Repo::discover(&cwd)?;
    let in_use = |branch: &str| -> Result<bool, CmdError> {
        Ok(repo
            .list_worktrees()?
            .iter()
            .any(|w| w.branch.as_deref() == Some(branch)))
    };
    if !fork {
        if in_use(head)? {
            return Err(xdev_workspace::WorkspaceError::BranchInUse(head.to_owned()).into());
        }
        if repo.branch_exists(head)? {
            // The user's branch now: a record of an earlier fetch no longer covers it.
            made().lock().unwrap().remove(&made_key(repo_id, head));
            return Ok(PrBranch {
                branch: head.to_owned(),
                fetched: false,
            });
        }
        fetch(&repo, head)?;
        made_insert(&repo, repo_id, head)?;
        return Ok(PrBranch {
            branch: head.to_owned(),
            fetched: true,
        });
    }
    for n in 1..=99u32 {
        let branch = if n == 1 {
            format!("{prefix}-{number}")
        } else {
            format!("{prefix}-{number}-{n}")
        };
        if !repo.branch_exists(&branch)? {
            fetch(&repo, &branch)?;
            made_insert(&repo, repo_id, &branch)?;
            return Ok(PrBranch {
                branch,
                fetched: true,
            });
        }
        // Taken, so the user's now: a record of an earlier fetch no longer covers it.
        made().lock().unwrap().remove(&made_key(repo_id, &branch));
    }
    Err(xdev_workspace::WorkspaceError::BranchExists(format!("{prefix}-{number}")).into())
}

#[tauri::command(async)]
pub fn prs_list(
    state: State<'_, AppState>,
    repo_id: String,
    query: PrQuery,
) -> Result<Vec<PrSummary>, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        list_with(gh, data, &repo_id, &query)
    })
}

#[tauri::command(async)]
pub fn pr_get(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<PrSummary, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        get_with(gh, data, &repo_id, number)
    })
}

#[tauri::command(async)]
pub fn pr_open(state: State<'_, AppState>, repo_id: String, number: u64) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        open_with(gh, data, &repo_id, number)
    })
}

/// Fetches the pull request's head when needed and returns the local branch
/// to put in a worktree. The fetch is network git, and no registry lock is
/// held: the registry is only read.
#[tauri::command(async)]
pub fn pr_branch(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<PrBranch, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        branch_with(gh, data, &repo_id, number)
    })
}

/// Takes back the branch `pr_branch` fetched when the worktree on it was never made. Only a
/// branch `pr_branch` made is deleted, and never one a worktree has.
#[tauri::command(async)]
pub fn pr_branch_discard(
    state: State<'_, AppState>,
    repo_id: String,
    branch: String,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    discard_with(data, &repo_id, &branch).map(drop)
}

#[tauri::command(async)]
pub fn projects_list(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<ProjectSummary>, CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| projects_with(gh, data, &repo_id))
}

#[tauri::command(async)]
pub fn project_open(
    state: State<'_, AppState>,
    repo_id: String,
    number: u64,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let account = account_of(data, &repo_id)?;
    run_gh(&SystemGh, account, |gh| {
        project_open_with(gh, data, &repo_id, number)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::process::Command;
    use xdev_git::{GhOutput, GitError};
    use xdev_workspace::{Registry, RepoEntry};

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

    fn pr(number: u64, head: &str, fork: bool) -> String {
        format!(
            r#"{{"number":{number},"url":"https://github.com/acme/app/pull/{number}","state":"OPEN","isDraft":false,"title":"T","baseRefName":"main","headRefName":"{head}","author":{{"login":"a"}},"updatedAt":"x","isCrossRepository":{fork}}}"#
        )
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    }

    /// A data dir whose registry holds repo `id` at `<tmp>/main`, a real git
    /// repo whose `origin` is a bare repo with `refs/pull/7/head` on it.
    fn fixture(id: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = crate::test_dirs::long_temp_dir("prs cmd ");
        let data = tmp.path().join("data");
        let main = tmp.path().join("main");
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&main).unwrap();
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "-q", "--bare"]);
        git(&main, &["init", "-q"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(
            &main,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&main, &["commit", "-q", "--allow-empty", "-m", "pr work"]);
        git(&main, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
        git(&main, &["reset", "-q", "--hard", "HEAD~1"]);
        let mut reg = Registry::load(&data).unwrap();
        reg.repos.push(RepoEntry {
            id: id.into(),
            path: main.clone(),
            ..RepoEntry::default()
        });
        reg.save(&data).unwrap();
        (tmp, data, main)
    }

    #[test]
    fn list_get_and_open_run_in_the_main_checkout() {
        let (_tmp, data, _) = fixture("r-prs");
        let fake = Fake::new(vec![
            (0, "[]", ""),
            (0, &pr(7, "feat/x", false), ""),
            (0, "", ""),
        ]);
        assert!(
            list_with(&fake, &data, "r-prs", &PrQuery::default())
                .unwrap()
                .is_empty()
        );
        assert_eq!(get_with(&fake, &data, "r-prs", 7).unwrap().number, 7);
        open_with(&fake, &data, "r-prs", 7).unwrap();
        assert_eq!(fake.calls.borrow()[2], ["pr", "view", "7", "--web"]);
        let err = list_with(&fake, &data, "nope", &PrQuery::default()).unwrap_err();
        assert_eq!(err.code, "repo_unknown");
    }

    #[test]
    fn projects_ask_repo_view_once_and_pass_the_owner() {
        let (_tmp, data, _) = fixture("r-proj");
        let projects = r#"{"projects":[{"number":1,"title":"P","url":"u","closed":false,"items":{"totalCount":2}}]}"#;
        let fake = Fake::new(vec![
            (0, r#"{"nameWithOwner":"acme/app"}"#, ""),
            (0, projects, ""),
            (0, projects, ""),
            (0, "", ""),
        ]);
        assert_eq!(projects_with(&fake, &data, "r-proj").unwrap()[0].items, 2);
        projects_with(&fake, &data, "r-proj").unwrap();
        project_open_with(&fake, &data, "r-proj", 1).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 4, "repo view only once");
        assert_eq!(calls[0][..2], ["repo", "view"]);
        assert_eq!(calls[1][..4], ["project", "list", "--owner", "acme"]);
        assert_eq!(calls[3][..5], ["project", "view", "1", "--owner", "acme"]);
    }

    #[test]
    fn pr_branch_fetches_the_head_into_a_free_branch() {
        let (_tmp, data, main) = fixture("r-b1");
        let fake = Fake::new(vec![(0, &pr(7, "feat/x", false), "")]);
        let got = branch_with(&fake, &data, "r-b1", 7).unwrap();
        assert_eq!(got.branch, "feat/x");
        assert!(got.fetched);
        assert_eq!(
            git(&main, &["log", "-1", "--format=%s", "feat/x"]).trim(),
            "pr work"
        );
    }

    #[test]
    fn pr_branch_reuses_a_local_head_and_fetches_nothing() {
        let (_tmp, data, main) = fixture("r-b2");
        git(&main, &["branch", "feat/x"]);
        let fake = Fake::new(vec![(0, &pr(7, "feat/x", false), "")]);
        let got = branch_with(&fake, &data, "r-b2", 7).unwrap();
        assert_eq!(got.branch, "feat/x");
        assert!(!got.fetched);
        // The branch was not moved to the PR's commit.
        assert_eq!(
            git(&main, &["log", "-1", "--format=%s", "feat/x"]).trim(),
            "one"
        );
    }

    #[test]
    fn pr_branch_refuses_a_checked_out_head() {
        let (_tmp, data, main) = fixture("r-b3");
        let current = git(&main, &["branch", "--show-current"]).trim().to_owned();
        let fake = Fake::new(vec![(0, &pr(7, &current, false), "")]);
        let err = branch_with(&fake, &data, "r-b3", 7).unwrap_err();
        assert_eq!(err.code, "branch_in_use");
    }

    #[test]
    fn pr_branch_puts_a_fork_on_pr_n_and_counts_up_when_taken() {
        let (_tmp, data, main) = fixture("r-b4");
        let fake = Fake::new(vec![
            (0, &pr(7, "main", true), ""),
            (0, &pr(7, "main", true), ""),
        ]);
        assert_eq!(branch_with(&fake, &data, "r-b4", 7).unwrap().branch, "pr-7");
        assert_eq!(
            branch_with(&fake, &data, "r-b4", 7).unwrap().branch,
            "pr-7-2"
        );
        assert_eq!(
            git(&main, &["log", "-1", "--format=%s", "pr-7-2"]).trim(),
            "pr work"
        );
    }

    #[test]
    fn discard_deletes_only_a_branch_the_flow_made() {
        let (_tmp, data, main) = fixture("r-d1");
        let exists = |b: &str| !git(&main, &["branch", "--list", b]).trim().is_empty();
        // Fetched by the flow: discarded.
        let fake = Fake::new(vec![(0, &pr(7, "feat/x", false), "")]);
        assert_eq!(
            branch_with(&fake, &data, "r-d1", 7).unwrap().branch,
            "feat/x"
        );
        assert!(exists("feat/x"));
        assert!(discard_with(&data, "r-d1", "feat/x").unwrap());
        assert!(!exists("feat/x"));
        // Asked twice: nothing more to do.
        assert!(!discard_with(&data, "r-d1", "feat/x").unwrap());
        // A branch the user had before is reused, not made, so it stays.
        git(&main, &["branch", "mine"]);
        let fake = Fake::new(vec![(0, &pr(7, "mine", false), "")]);
        assert_eq!(branch_with(&fake, &data, "r-d1", 7).unwrap().branch, "mine");
        assert!(!discard_with(&data, "r-d1", "mine").unwrap());
        assert!(exists("mine"));
        // A branch the flow never saw stays too.
        git(&main, &["branch", "other"]);
        assert!(!discard_with(&data, "r-d1", "other").unwrap());
        assert!(exists("other"));
    }

    #[test]
    fn discard_keeps_a_branch_a_worktree_took() {
        let (tmp, data, main) = fixture("r-d2");
        let fake = Fake::new(vec![(0, &pr(7, "main", true), "")]);
        let branch = branch_with(&fake, &data, "r-d2", 7).unwrap().branch;
        assert_eq!(branch, "pr-7");
        let wt = tmp.path().join("wt-pr7");
        git(
            &main,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "pr-7"],
        );
        assert!(!discard_with(&data, "r-d2", "pr-7").unwrap());
        assert!(!git(&main, &["branch", "--list", "pr-7"]).trim().is_empty());
    }

    #[test]
    fn discard_keeps_a_branch_the_user_committed_on_and_reused() {
        let (tmp, data, main) = fixture("r-d3");
        let exists = |b: &str| !git(&main, &["branch", "--list", b]).trim().is_empty();
        let script = || Fake::new(vec![(0, &pr(7, "feat/x", false), "")]);
        assert!(branch_with(&script(), &data, "r-d3", 7).unwrap().fetched);
        // Work on the branch in a worktree, which is then removed; the branch stays.
        let wt = tmp.path().join("wt-x");
        git(
            &main,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "feat/x"],
        );
        git(&wt, &["commit", "-q", "--allow-empty", "-m", "mine"]);
        git(
            &main,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        // The same pull request again reuses the branch and no longer owns it.
        let again = branch_with(&script(), &data, "r-d3", 7).unwrap();
        assert!(!again.fetched);
        assert!(!discard_with(&data, "r-d3", "feat/x").unwrap());
        assert!(exists("feat/x"));
    }

    #[test]
    fn discard_keeps_a_branch_whose_tip_moved_or_was_recreated() {
        let (_tmp, data, main) = fixture("r-d4");
        let exists = |b: &str| !git(&main, &["branch", "--list", b]).trim().is_empty();
        let script = || Fake::new(vec![(0, &pr(7, "feat/x", false), "")]);
        // The tip moved after the fetch: kept.
        branch_with(&script(), &data, "r-d4", 7).unwrap();
        git(&main, &["branch", "-f", "feat/x", "HEAD"]);
        assert!(!discard_with(&data, "r-d4", "feat/x").unwrap());
        assert!(exists("feat/x"));
        git(&main, &["branch", "-D", "feat/x"]);
        // The user deletes it and makes a same-name branch elsewhere: kept.
        branch_with(&script(), &data, "r-d4", 7).unwrap();
        git(&main, &["branch", "-D", "feat/x"]);
        git(&main, &["branch", "feat/x"]);
        assert!(!discard_with(&data, "r-d4", "feat/x").unwrap());
        assert!(exists("feat/x"));
    }

    #[test]
    fn discard_keeps_the_fork_branch_a_later_call_skipped() {
        let (_tmp, data, main) = fixture("r-d5");
        let script = || Fake::new(vec![(0, &pr(7, "main", true), "")]);
        assert_eq!(
            branch_with(&script(), &data, "r-d5", 7).unwrap().branch,
            "pr-7"
        );
        // `pr-7` is taken now, so the next call skips it: it is the user's, not ours to discard.
        let second = branch_with(&script(), &data, "r-d5", 7).unwrap();
        assert_eq!(second.branch, "pr-7-2");
        assert!(!discard_with(&data, "r-d5", "pr-7").unwrap());
        assert!(!git(&main, &["branch", "--list", "pr-7"]).trim().is_empty());
        assert!(discard_with(&data, "r-d5", "pr-7-2").unwrap());
    }

    #[test]
    fn a_fetch_whose_branch_cannot_be_resolved_is_an_error_and_not_recorded() {
        let (_tmp, data, main) = fixture("r-d6");
        let repo = Repo::discover(&main).unwrap();
        assert!(made_insert(&repo, "r-d6", "no-such-branch").is_err());
        assert!(
            !made()
                .lock()
                .unwrap()
                .contains_key(&made_key("r-d6", "no-such-branch"))
        );
        let _ = data;
    }

    #[test]
    fn pr_branch_reports_a_missing_pull_request() {
        let (_tmp, data, _) = fixture("r-b5");
        let fake = Fake::new(vec![(1, "", "Could not resolve to a PullRequest")]);
        let err = branch_with(&fake, &data, "r-b5", 9).unwrap_err();
        assert_eq!(err.code, "pr_not_found");
    }
}
