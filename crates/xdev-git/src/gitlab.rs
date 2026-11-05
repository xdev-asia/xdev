//! Merge requests through the `glab` program. The program sits behind
//! `GlabExec` so tests never run the real one.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::gh::{GhOutput, run_program};
use crate::remote::{failed, plain_remote};
use crate::{GitError, PrFilter, Repo, run};

/// Most merge requests one list call returns.
const LIST_LIMIT: &str = "100";

pub trait GlabExec {
    fn run(&self, cwd: &Path, args: &[&str]) -> Result<GhOutput, GitError>;
}

/// Runs `glab` from `PATH`.
pub struct SystemGlab;

impl GlabExec for SystemGlab {
    fn run(&self, cwd: &Path, args: &[&str]) -> Result<GhOutput, GitError> {
        run_program(
            "glab",
            cwd,
            args,
            None,
            &[("NO_PROMPT", "1"), ("NO_COLOR", "1")],
            || GitError::GlabMissing,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum MrState {
    Open,
    Merged,
    Closed,
}

/// A row of `glab mr list` or `glab mr view <iid>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MrSummary {
    /// The number in the project (`!12`), not the instance-wide id.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub iid: u64,
    pub url: String,
    pub state: MrState,
    pub draft: bool,
    pub title: String,
    pub source: String,
    pub target: String,
    pub author: Option<String>,
    /// RFC 3339 as GitLab prints it.
    pub updated_at: String,
    /// The source branch lives in another project.
    pub fork: bool,
}

#[derive(Deserialize)]
struct RawAuthor {
    #[serde(default)]
    username: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawMr {
    iid: u64,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    title: String,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    author: Option<RawAuthor>,
    #[serde(default)]
    updated_at: String,
    source_project_id: Option<u64>,
    target_project_id: Option<u64>,
}

impl From<RawMr> for MrSummary {
    fn from(raw: RawMr) -> MrSummary {
        // `locked` is a request being merged right now.
        let state = match raw.state.as_str() {
            "merged" => MrState::Merged,
            "closed" => MrState::Closed,
            _ => MrState::Open,
        };
        let draft = raw.draft
            || raw.work_in_progress
            || raw.title.starts_with("Draft:")
            || raw.title.starts_with("[Draft]");
        let author = raw.author.and_then(|a| {
            let name = if a.username.is_empty() {
                a.name
            } else {
                a.username
            };
            (!name.is_empty()).then_some(name)
        });
        let fork = matches!(
            (raw.source_project_id, raw.target_project_id),
            (Some(s), Some(t)) if s != t
        );
        MrSummary {
            iid: raw.iid,
            url: raw.web_url,
            state,
            draft,
            title: raw.title,
            source: raw.source_branch,
            target: raw.target_branch,
            author,
            updated_at: raw.updated_at,
            fork,
        }
    }
}

/// The one reading of a failed `glab` run.
fn classify(out: &GhOutput) -> GitError {
    let err = &out.stderr;
    if err.contains("glab auth login") || err.contains("401 Unauthorized") {
        GitError::GlabAuth
    } else if err.contains("none of the git remotes") {
        GitError::NotGitlab
    } else {
        GitError::Glab(err.trim().to_owned())
    }
}

fn parse_error(e: serde_json::Error) -> GitError {
    GitError::Glab(format!("unexpected glab output: {e}"))
}

/// The merge requests in `glab mr list --output json` text.
pub(crate) fn parse_mr_list(json: &str) -> Result<Vec<MrSummary>, GitError> {
    // An empty list may come as no text at all.
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawMr> = serde_json::from_str(json).map_err(parse_error)?;
    Ok(raw.into_iter().map(MrSummary::from).collect())
}

/// The merge request in `glab mr view <iid> --output json` text.
pub(crate) fn parse_mr(json: &str) -> Result<MrSummary, GitError> {
    let raw: RawMr = serde_json::from_str(json).map_err(parse_error)?;
    Ok(raw.into())
}

pub fn glab_mr_list(
    glab: &dyn GlabExec,
    cwd: &Path,
    state: Option<PrFilter>,
) -> Result<Vec<MrSummary>, GitError> {
    let mut args = vec!["mr", "list", "--output", "json", "--per-page", LIST_LIMIT];
    match state {
        Some(PrFilter::Closed) => args.push("--closed"),
        Some(PrFilter::Merged) => args.push("--merged"),
        Some(PrFilter::All) => args.push("--all"),
        Some(PrFilter::Open) | None => {}
    }
    let out = glab.run(cwd, &args)?;
    if out.status != Some(0) {
        return Err(classify(&out));
    }
    parse_mr_list(&out.stdout)
}

pub fn glab_mr_view(glab: &dyn GlabExec, cwd: &Path, iid: u64) -> Result<MrSummary, GitError> {
    let iid = iid.to_string();
    let out = glab.run(cwd, &["mr", "view", &iid, "--output", "json"])?;
    if out.status != Some(0) {
        if out.stderr.contains("404") {
            return Err(GitError::MrNotFound);
        }
        return Err(classify(&out));
    }
    parse_mr(&out.stdout)
}

/// The host of a remote URL, lowercased: `https://host/..`, `ssh://git@host:22/..` or the scp
/// style `git@host:path`.
fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    let host_port = if let Some((_, rest)) = url.split_once("://") {
        let authority = rest.split('/').next()?;
        authority.rsplit_once('@').map_or(authority, |(_, h)| h)
    } else {
        let (left, _) = url.split_once(':')?;
        if left.contains('/') {
            return None;
        }
        left.rsplit_once('@').map_or(left, |(_, h)| h)
    };
    let host = if let Some(v6) = host_port.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        host_port.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether a remote URL names GitLab: gitlab.com, or a host with `gitlab` in its name (a
/// self-hosted instance). Only the host counts, so a GitHub repo called `gitlab` is not one.
pub fn is_gitlab_remote(url: &str) -> bool {
    remote_host(url).is_some_and(|h| h == "gitlab.com" || h.contains("gitlab"))
}

impl Repo {
    /// The remote git fetches from by default: the only one, else `origin`.
    fn gitlab_default_remote(&self) -> Result<Option<String>, GitError> {
        let names = self.remote_names()?;
        Ok(match names.as_slice() {
            [only] => Some(only.clone()),
            _ if names.iter().any(|n| n == "origin") => Some("origin".to_owned()),
            _ => None,
        })
    }

    /// The default remote when its URL names GitLab.
    pub fn gitlab_remote(&self) -> Result<Option<String>, GitError> {
        let Some(remote) = self.gitlab_default_remote()? else {
            return Ok(None);
        };
        let remote = plain_remote(remote)?;
        // The URL as configured: `get-url` would show it after `insteadOf` rewriting.
        let key = format!("remote.{remote}.url");
        let (status, out) = run::run_status(&self.workdir, &["config", "--get", &key], None)?;
        if status != Some(0) {
            return Ok(None);
        }
        Ok(is_gitlab_remote(&String::from_utf8_lossy(&out)).then_some(remote))
    }

    /// Fetches the head of merge request `iid` into local branch `branch`
    /// (`fetch <remote> refs/merge-requests/<iid>/head:refs/heads/<branch>`). No `+`: a branch
    /// that exists and is not an ancestor is refused, never overwritten. The ref exists for
    /// merge requests from forks too.
    pub fn fetch_merge_request(&self, iid: u64, branch: &str) -> Result<(), GitError> {
        if !self.valid_branch_name(branch)? {
            return Err(GitError::BadId(branch.to_owned()));
        }
        let remote = self.gitlab_remote()?.ok_or(GitError::NotGitlab)?;
        let spec = format!("refs/merge-requests/{iid}/head:refs/heads/{branch}");
        let out = run::run_long(&self.workdir, &["fetch", "-q", &remote, &spec])?;
        if out.status != Some(0) {
            return Err(failed("fetch", &out));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const LIST: &str = r#"[
      {"id":901,"iid":12,"project_id":7,"title":"Fix footer meter","state":"opened",
       "updated_at":"2026-10-01T10:00:00.000Z","source_branch":"fix-footer","target_branch":"main",
       "author":{"id":3,"username":"ann","name":"Ann Lee"},"draft":false,
       "web_url":"https://gitlab.com/acme/app/-/merge_requests/12",
       "source_project_id":7,"target_project_id":7,"labels":["ui"],"unknown":{"x":1}},
      {"iid":13,"title":"Draft: dark mode","state":"opened","source_branch":"dark","target_branch":"main",
       "author":{"name":"Bo"},"web_url":"https://gitlab.com/acme/app/-/merge_requests/13",
       "source_project_id":8,"target_project_id":7},
      {"iid":14,"title":"Old","state":"merged","work_in_progress":true},
      {"iid":15,"title":"Gone","state":"closed","author":null},
      {"iid":16,"title":"Landing","state":"locked"}
    ]"#;

    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        out: GhOutput,
    }

    impl Fake {
        fn new(status: i32, stdout: &str, stderr: &str) -> Fake {
            Fake {
                calls: RefCell::default(),
                out: GhOutput {
                    status: Some(status),
                    stdout: stdout.into(),
                    stderr: stderr.into(),
                },
            }
        }
    }

    impl GlabExec for Fake {
        fn run(&self, _: &Path, args: &[&str]) -> Result<GhOutput, GitError> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            Ok(GhOutput {
                status: self.out.status,
                stdout: self.out.stdout.clone(),
                stderr: self.out.stderr.clone(),
            })
        }
    }

    #[test]
    fn list_maps_the_fields_glab_prints() {
        let mrs = parse_mr_list(LIST).unwrap();
        assert_eq!(mrs.len(), 5);
        let first = &mrs[0];
        assert_eq!(first.iid, 12);
        assert_eq!(first.state, MrState::Open);
        assert_eq!(first.source, "fix-footer");
        assert_eq!(first.target, "main");
        assert_eq!(first.author.as_deref(), Some("ann"));
        assert_eq!(first.url, "https://gitlab.com/acme/app/-/merge_requests/12");
        assert_eq!(first.updated_at, "2026-10-01T10:00:00.000Z");
        assert!(!first.draft && !first.fork);
    }

    #[test]
    fn list_is_tolerant_of_missing_fields() {
        let mrs = parse_mr_list(LIST).unwrap();
        // A title prefix is a draft; a name stands in for a missing username; projects differ: fork.
        assert!(mrs[1].draft && mrs[1].fork);
        assert_eq!(mrs[1].author.as_deref(), Some("Bo"));
        // The old flag is a draft too; no projects: not a fork; no update time: empty.
        assert!(mrs[2].draft && !mrs[2].fork);
        assert_eq!(mrs[2].state, MrState::Merged);
        assert_eq!(mrs[2].updated_at, "");
        assert_eq!(mrs[3].state, MrState::Closed);
        assert_eq!(mrs[3].author, None);
        assert_eq!(mrs[4].state, MrState::Open);
    }

    #[test]
    fn an_empty_or_odd_list_is_handled() {
        assert!(parse_mr_list("[]").unwrap().is_empty());
        assert!(parse_mr_list("  \n").unwrap().is_empty());
        assert_eq!(parse_mr_list("{").unwrap_err().code(), "glab_failed");
        assert_eq!(
            parse_mr_list(r#"[{"title":"no iid"}]"#).unwrap_err().code(),
            "glab_failed"
        );
    }

    #[test]
    fn view_parses_one_object() {
        let mr = parse_mr(r#"{"iid":9,"title":"T","state":"closed","draft":true}"#).unwrap();
        assert_eq!((mr.iid, mr.state, mr.draft), (9, MrState::Closed, true));
    }

    #[test]
    fn list_args_follow_the_state() {
        let cwd = Path::new(".");
        let fake = Fake::new(0, "[]", "");
        glab_mr_list(&fake, cwd, None).unwrap();
        glab_mr_list(&fake, cwd, Some(PrFilter::Merged)).unwrap();
        glab_mr_list(&fake, cwd, Some(PrFilter::Closed)).unwrap();
        glab_mr_list(&fake, cwd, Some(PrFilter::All)).unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls[0][..4], ["mr", "list", "--output", "json"]);
        assert_eq!(calls[0].len(), 6);
        assert_eq!(calls[1].last().unwrap(), "--merged");
        assert_eq!(calls[2].last().unwrap(), "--closed");
        assert_eq!(calls[3].last().unwrap(), "--all");
    }

    #[test]
    fn view_args_and_not_found() {
        let cwd = Path::new(".");
        let fake = Fake::new(0, r#"{"iid":9}"#, "");
        assert_eq!(glab_mr_view(&fake, cwd, 9).unwrap().iid, 9);
        assert_eq!(
            fake.calls.borrow()[0],
            ["mr", "view", "9", "--output", "json"]
        );
        let gone = Fake::new(1, "", "GET https://gitlab.com/api/v4/x: 404 Not Found");
        assert_eq!(
            glab_mr_view(&gone, cwd, 9).unwrap_err().code(),
            "mr_not_found"
        );
    }

    #[test]
    fn failures_map_to_the_gh_kinds() {
        let cwd = Path::new(".");
        let code = |stderr: &str| {
            glab_mr_list(&Fake::new(1, "", stderr), cwd, None)
                .unwrap_err()
                .code()
        };
        assert_eq!(code("run glab auth login to sign in"), "glab_auth");
        assert_eq!(code("GET https://x/api: 401 Unauthorized"), "glab_auth");
        assert_eq!(
            code(
                "none of the git remotes configured for this repository point to a known GitLab host"
            ),
            "not_gitlab"
        );
        assert_eq!(code("boom\n"), "glab_failed");
        let err = glab_mr_list(&Fake::new(1, "", " boom\n"), cwd, None).unwrap_err();
        assert!(matches!(err, GitError::Glab(d) if d == "boom"));
    }

    #[test]
    fn a_missing_program_is_glab_missing() {
        let err = run_program(
            "xdev-no-such-program",
            Path::new("."),
            &[],
            None,
            &[],
            || GitError::GlabMissing,
        )
        .unwrap_err();
        assert_eq!(err.code(), "glab_missing");
    }

    #[test]
    fn detects_gitlab_remotes() {
        for url in [
            "https://gitlab.com/acme/app.git",
            "git@gitlab.com:acme/app.git",
            "ssh://git@gitlab.com/acme/app.git",
            "https://user:tok@gitlab.example.org/g/sub/app.git",
            "git@gitlab.corp.internal:g/app.git",
            "ssh://git@code-gitlab.corp:2222/g/app.git",
            "HTTPS://GitLab.com/acme/app",
            " https://gitlab.com/acme/app \n",
        ] {
            assert!(is_gitlab_remote(url), "{url}");
        }
        for url in [
            "https://github.com/acme/app.git",
            "git@github.com:gitlab/app.git",
            "https://github.com/gitlab-org/gitlab",
            "https://bitbucket.org/acme/app.git",
            "git@git.example.com:acme/app.git",
            "/srv/git/gitlab.git",
            "../gitlab",
            "",
        ] {
            assert!(!is_gitlab_remote(url), "{url}");
        }
    }
}
