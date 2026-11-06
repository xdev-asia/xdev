//! The file commands on a remote project: the same answers as the local
//! ones in `files.rs`, over the host's SFTP session and exec channel.

use std::path::{Path, PathBuf};

use xdev_policy::Action;
use xdev_ssh::{RemoteError, RemoteRef, join_rel};
use xdev_workspace::{
    Eol, FileList, FileText, IMAGE_MAX, MEDIA_MAX, MediaKind, WorkspaceError, WriteOutcome,
    media_kind,
};

use super::{RemoteHub, project_host};
use crate::commands::CmdError;

pub(crate) fn read(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
    rel: &str,
) -> Result<FileText, CmdError> {
    let host = project_host(data, r)?;
    hub.with_fs(&host, |fs| fs.read_file(&r.path, rel))
}

/// An image, audio or video file within its cap, like `read_bytes`.
pub(crate) fn bytes(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
    rel: &str,
) -> Result<Vec<u8>, CmdError> {
    let host = project_host(data, r)?;
    let cap = match media_kind(rel) {
        Some(MediaKind::Image) => IMAGE_MAX,
        Some(MediaKind::Audio | MediaKind::Video) => MEDIA_MAX,
        None => return Err(WorkspaceError::BadName(rel.to_owned()).into()),
    };
    hub.with_fs(&host, |fs| {
        let path = fs.checked(&r.path, rel)?;
        let attrs = fs.sftp.stat(&path)?;
        if attrs.is_dir() {
            return Err(RemoteError::BadPath(rel.to_owned()));
        }
        if attrs.size.unwrap_or(0) > cap {
            return Err(RemoteError::TooLarge);
        }
        fs.sftp.read_file(&path, cap)
    })
}

pub(crate) fn write(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
    rel: &str,
    text: &str,
    eol: Eol,
    expected: Option<&str>,
) -> Result<WriteOutcome, CmdError> {
    let host = project_host(data, r)?;
    hub.with_fs(&host, |fs| fs.write_file(&r.path, rel, text, eol, expected))
}

pub(crate) fn create(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
    rel: &str,
    dir: bool,
) -> Result<(), CmdError> {
    let host = project_host(data, r)?;
    hub.with_fs(&host, |fs| fs.create_entry(&r.path, rel, dir))
}

pub(crate) fn rename(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
    from: &str,
    to: &str,
) -> Result<(), CmdError> {
    let host = project_host(data, r)?;
    hub.with_fs(&host, |fs| fs.rename_entry(&r.path, from, to))
}

/// A host has no trash: the policy gate is asked for `Delete` of the
/// `ssh://` path (as confirmed, like a local delete), then it is removed.
pub(crate) fn trash(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
    rel: &str,
) -> Result<(), CmdError> {
    let host = project_host(data, r)?;
    let joined = join_rel(&r.path, rel)?;
    let path = PathBuf::from(format!("ssh://{}{joined}", r.host_id));
    crate::workspace::allowed(data, &Action::Delete { path }, true)?;
    hub.with_fs(&host, |fs| fs.remove_entry(&r.path, rel))
}

pub(crate) fn list(hub: &RemoteHub, data: &Path, r: &RemoteRef) -> Result<FileList, CmdError> {
    let host = project_host(data, r)?;
    hub.with_fs(&host, |fs| fs.list_files(&r.path))
}

/// `git status` of the project on the host.
pub(crate) fn changes(
    hub: &RemoteHub,
    data: &Path,
    r: &RemoteRef,
) -> Result<Vec<xdev_git::FileStatus>, CmdError> {
    let host = project_host(data, r)?;
    hub.with_fs(&host, |fs| fs.git_status(&r.path))
}
