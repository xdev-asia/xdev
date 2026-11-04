//! Web URLs of a commit or file on GitHub, GitLab or Bitbucket.

use crate::{GitError, Repo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    Github,
    Gitlab,
    Bitbucket,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRepo {
    pub kind: HostKind,
    /// `https://host/owner/repo`.
    pub base: String,
}

/// The hosted repository a remote URL names; `None` for any other host or
/// a URL with fewer than two path segments.
pub fn parse_host_remote(url: &str) -> Option<HostRepo> {
    let _ = url;
    None
}

pub fn commit_url(host: &HostRepo, id: &str) -> String {
    let _ = id;
    host.base.clone()
}

pub fn file_url(
    host: &HostRepo,
    git_ref: &str,
    path: &str,
    line: Option<u32>,
    end: Option<u32>,
) -> String {
    let _ = (git_ref, path, line, end);
    host.base.clone()
}

impl Repo {
    /// The hosted repository behind the `origin` remote.
    pub fn origin_host(&self) -> Result<Option<HostRepo>, GitError> {
        Ok(None)
    }

    /// The hosted repository and the ref a file link should use.
    pub fn file_host_target(&self) -> Result<Option<(HostRepo, String)>, GitError> {
        Ok(None)
    }
}
