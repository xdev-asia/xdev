//! GitLab merge requests of a registered repo, read through `glab` in its main checkout, and the
//! local branch a merge request is started on.

use std::path::Path;

use tauri::State;
use xdev_git::{GlabExec, MrSummary, PrFilter, Repo, SystemGlab, glab_mr_list, glab_mr_view};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::issues::main_path;
use crate::prs::{PrBranch, branch_for};

fn detect_with(data: &Path, repo_id: &str) -> Result<bool, CmdError> {
    let repo = Repo::discover(&main_path(data, repo_id)?)?;
    Ok(repo.gitlab_remote()?.is_some())
}

fn list_with(
    glab: &dyn GlabExec,
    data: &Path,
    repo_id: &str,
    state: Option<PrFilter>,
) -> Result<Vec<MrSummary>, CmdError> {
    Ok(glab_mr_list(glab, &main_path(data, repo_id)?, state)?)
}

fn view_with(
    glab: &dyn GlabExec,
    data: &Path,
    repo_id: &str,
    iid: u64,
) -> Result<MrSummary, CmdError> {
    Ok(glab_mr_view(glab, &main_path(data, repo_id)?, iid)?)
}

/// The local branch to start merge request `iid` on, with the rules of `pr_branch`: its source
/// branch when that is free, `mr-<iid>` (or `mr-<iid>-2`, …) for a merge request from a fork. The
/// head is fetched from `refs/merge-requests/<iid>/head`, which a fork's request has too.
fn branch_with(
    glab: &dyn GlabExec,
    data: &Path,
    repo_id: &str,
    iid: u64,
) -> Result<PrBranch, CmdError> {
    let mr = glab_mr_view(glab, &main_path(data, repo_id)?, iid)?;
    branch_for(
        data,
        repo_id,
        &mr.source,
        mr.fork,
        "mr",
        iid,
        &|repo, branch| repo.fetch_merge_request(iid, branch),
    )
}

/// Whether the repo's remote is a GitLab one, so the merge request views apply.
#[tauri::command(async)]
pub fn gitlab_detect(state: State<'_, AppState>, repo_id: String) -> Result<bool, CmdError> {
    detect_with(data_dir(&state)?, &repo_id)
}

#[tauri::command(async)]
pub fn gitlab_mr_list(
    state: State<'_, AppState>,
    repo_id: String,
    filter: Option<PrFilter>,
) -> Result<Vec<MrSummary>, CmdError> {
    list_with(&SystemGlab, data_dir(&state)?, &repo_id, filter)
}

#[tauri::command(async)]
pub fn gitlab_mr_view(
    state: State<'_, AppState>,
    repo_id: String,
    iid: u64,
) -> Result<MrSummary, CmdError> {
    view_with(&SystemGlab, data_dir(&state)?, &repo_id, iid)
}

/// Fetches the merge request's head when needed and returns the local branch to put in a
/// worktree. A branch it fetched can be taken back with `pr_branch_discard`.
#[tauri::command(async)]
pub fn gitlab_mr_branch(
    state: State<'_, AppState>,
    repo_id: String,
    iid: u64,
) -> Result<PrBranch, CmdError> {
    branch_with(&SystemGlab, data_dir(&state)?, &repo_id, iid)
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

    impl GlabExec for Fake {
        fn run(&self, cwd: &Path, args: &[&str]) -> Result<GhOutput, GitError> {
            assert!(cwd.ends_with("main"), "runs in the main checkout: {cwd:?}");
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            Ok(self.script.borrow_mut().pop_front().expect("scripted"))
        }
    }

    fn mr(iid: u64, source: &str, fork: bool) -> String {
        let project = if fork { 8 } else { 7 };
        format!(
            r#"{{"iid":{iid},"title":"T","state":"opened","source_branch":"{source}","target_branch":"main","web_url":"https://gitlab.com/acme/app/-/merge_requests/{iid}","source_project_id":{project},"target_project_id":7}}"#
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

    const URL: &str = "https://gitlab.com/acme/app.git";

    /// A data dir whose registry holds repo `id` at `<tmp>/main`, a real git repo whose `origin`
    /// is named by a GitLab URL that git rewrites to a bare repo with `refs/merge-requests/7/head`.
    fn fixture(id: &str, url: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = crate::test_dirs::long_temp_dir("gitlab cmd ");
        let data = tmp.path().join("data");
        let main = tmp.path().join("main");
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&main).unwrap();
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "-q", "--bare"]);
        git(&main, &["init", "-q"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(&main, &["remote", "add", "origin", url]);
        git(
            &main,
            &[
                "config",
                &format!("url.{}.insteadOf", remote.to_str().unwrap()),
                url,
            ],
        );
        git(&main, &["commit", "-q", "--allow-empty", "-m", "mr work"]);
        git(
            &main,
            &[
                "push",
                "-q",
                remote.to_str().unwrap(),
                "HEAD:refs/merge-requests/7/head",
            ],
        );
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
    fn detect_follows_the_remote_url() {
        let (_tmp, data, _) = fixture("g-det1", URL);
        assert!(detect_with(&data, "g-det1").unwrap());
        let (_tmp, data, _) = fixture("g-det2", "https://github.com/acme/app.git");
        assert!(!detect_with(&data, "g-det2").unwrap());
        assert_eq!(detect_with(&data, "nope").unwrap_err().code, "repo_unknown");
    }

    #[test]
    fn list_and_view_run_in_the_main_checkout() {
        let (_tmp, data, _) = fixture("g-list", URL);
        let fake = Fake::new(vec![(0, "[]", ""), (0, &mr(7, "feat/x", false), "")]);
        assert!(list_with(&fake, &data, "g-list", None).unwrap().is_empty());
        assert_eq!(view_with(&fake, &data, "g-list", 7).unwrap().iid, 7);
        assert_eq!(fake.calls.borrow()[1][..3], ["mr", "view", "7"]);
        let err = list_with(&fake, &data, "nope", None).unwrap_err();
        assert_eq!(err.code, "repo_unknown");
    }

    #[test]
    fn a_glab_failure_keeps_its_kind() {
        let (_tmp, data, _) = fixture("g-err", URL);
        let fake = Fake::new(vec![(1, "", "run glab auth login")]);
        assert_eq!(
            list_with(&fake, &data, "g-err", None).unwrap_err().code,
            "glab_auth"
        );
    }

    #[test]
    fn branch_fetches_the_head_into_the_source_branch() {
        let (_tmp, data, main) = fixture("g-b1", URL);
        let fake = Fake::new(vec![(0, &mr(7, "feat/x", false), "")]);
        let got = branch_with(&fake, &data, "g-b1", 7).unwrap();
        assert_eq!((got.branch.as_str(), got.fetched), ("feat/x", true));
        assert_eq!(
            git(&main, &["log", "-1", "--format=%s", "feat/x"]).trim(),
            "mr work"
        );
    }

    #[test]
    fn branch_reuses_a_local_source_branch() {
        let (_tmp, data, main) = fixture("g-b2", URL);
        git(&main, &["branch", "feat/x"]);
        let fake = Fake::new(vec![(0, &mr(7, "feat/x", false), "")]);
        let got = branch_with(&fake, &data, "g-b2", 7).unwrap();
        assert!(!got.fetched);
        assert_eq!(
            git(&main, &["log", "-1", "--format=%s", "feat/x"]).trim(),
            "one"
        );
    }

    #[test]
    fn branch_puts_a_fork_on_mr_n_and_counts_up_when_taken() {
        let (_tmp, data, main) = fixture("g-b3", URL);
        let fake = Fake::new(vec![
            (0, &mr(7, "main", true), ""),
            (0, &mr(7, "main", true), ""),
        ]);
        assert_eq!(branch_with(&fake, &data, "g-b3", 7).unwrap().branch, "mr-7");
        assert_eq!(
            branch_with(&fake, &data, "g-b3", 7).unwrap().branch,
            "mr-7-2"
        );
        assert_eq!(
            git(&main, &["log", "-1", "--format=%s", "mr-7-2"]).trim(),
            "mr work"
        );
    }

    #[test]
    fn branch_refuses_a_checked_out_source() {
        let (_tmp, data, main) = fixture("g-b4", URL);
        let current = git(&main, &["branch", "--show-current"]).trim().to_owned();
        let fake = Fake::new(vec![(0, &mr(7, &current, false), "")]);
        let err = branch_with(&fake, &data, "g-b4", 7).unwrap_err();
        assert_eq!(err.code, "branch_in_use");
    }

    #[test]
    fn branch_reports_a_missing_merge_request() {
        let (_tmp, data, _) = fixture("g-b5", URL);
        let fake = Fake::new(vec![(1, "", "404 Not Found")]);
        let err = branch_with(&fake, &data, "g-b5", 9).unwrap_err();
        assert_eq!(err.code, "mr_not_found");
    }

    #[test]
    fn branch_on_a_github_repo_is_not_gitlab() {
        let (_tmp, data, _) = fixture("g-b6", "https://github.com/acme/app.git");
        let fake = Fake::new(vec![(0, &mr(7, "feat/x", false), "")]);
        let err = branch_with(&fake, &data, "g-b6", 7).unwrap_err();
        assert_eq!(err.code, "not_gitlab");
    }
}
