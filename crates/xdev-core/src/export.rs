use std::path::{Path, PathBuf};

use xdev_export::{ExportDoc, PlannedFile, estimate_tokens, plan, render};
use xdev_git::{GitError, Repo};
use xdev_vault::{Vault, VaultError, extract_title, parse_frontmatter};

use crate::CoreError;

/// A doc marked for agents; `path` is vault-relative so the UI can open it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ExportedDoc {
    pub path: String,
    pub title: String,
    pub targets: Vec<xdev_export::Target>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ExportPlan {
    /// For display only.
    pub root: String,
    pub files: Vec<PlannedFile>,
    pub docs: Vec<ExportedDoc>,
    /// Estimate for AGENTS.md, 0 when it is not written.
    pub tokens: usize,
}

/// Agents read `AGENTS.md` at the repo's top folder, and the usual vault is
/// `repo/docs/`, so the files go to the repo root when there is one.
pub fn export_root(vault: &Vault) -> Result<PathBuf, CoreError> {
    match Repo::discover(vault.root()) {
        Ok(repo) => Ok(repo.root()),
        // Without git the vault is still a folder of docs worth exporting.
        Err(GitError::NoRepo | GitError::NoGit) => Ok(vault.root().to_path_buf()),
        Err(e) => Err(e.into()),
    }
}

pub fn export_plan(vault: &Vault, root: &Path) -> Result<ExportPlan, CoreError> {
    let prefix = source_prefix(vault, root);
    let mut docs = Vec::new();
    let mut inputs = Vec::new();
    for meta in vault.list()? {
        let content = match vault.read(&meta.path) {
            Ok(content) => content,
            // The index skips these too; one odd file must not block the
            // export of the rest.
            Err(VaultError::NotFound(_) | VaultError::NotUtf8(_) | VaultError::TooLarge(_)) => {
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let (fm, body) = parse_frontmatter(&content);
        if fm.agents.is_empty() {
            continue;
        }
        let targets: Vec<xdev_export::Target> = fm.agents.iter().map(|&t| target(t)).collect();
        let title = extract_title(&meta.path, &content);
        inputs.push(ExportDoc {
            source: format!("{prefix}{}", meta.path),
            title: title.clone(),
            targets: targets.clone(),
            body: body.to_owned(),
        });
        docs.push(ExportedDoc {
            path: meta.path,
            title,
            targets,
        });
    }
    let files = plan(root, render(&inputs))?;
    let tokens = files
        .iter()
        .find(|f| f.path == "AGENTS.md")
        .map_or(0, |f| estimate_tokens(&f.new));
    Ok(ExportPlan {
        root: display_path(root),
        files,
        docs,
        tokens,
    })
}

/// `expected` is the `(path, hash)` of every `new` or `changed` file the
/// user saw. Anything else now means the preview is out of date, and
/// nothing is written.
pub fn export_write(
    vault: &Vault,
    root: &Path,
    expected: &[(String, String)],
) -> Result<Vec<String>, CoreError> {
    let current = export_plan(vault, root)?;
    let mut pending: Vec<(String, String)> = current
        .files
        .iter()
        .filter(|f| {
            matches!(
                f.status,
                xdev_export::FileStatus::New | xdev_export::FileStatus::Changed
            )
        })
        .map(|f| (f.path.clone(), f.hash.clone()))
        .collect();
    let mut expected = expected.to_vec();
    pending.sort();
    expected.sort();
    if pending != expected {
        return Err(xdev_export::ExportError::Stale.into());
    }
    Ok(xdev_export::write(root, &current.files)?)
}

/// The vault's folder inside the export root, as `"docs/"` or `""`.
fn source_prefix(vault: &Vault, root: &Path) -> String {
    let Ok(rel) = vault.root().strip_prefix(root) else {
        return String::new();
    };
    rel.components()
        .map(|c| format!("{}/", c.as_os_str().to_string_lossy()))
        .collect()
}

/// Canonical Windows paths carry `\\?\`, which means nothing to a reader.
fn display_path(path: &Path) -> String {
    let s = path.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => s,
    }
}

fn target(t: xdev_vault::Target) -> xdev_export::Target {
    match t {
        xdev_vault::Target::Agents => xdev_export::Target::Agents,
        xdev_vault::Target::Claude => xdev_export::Target::Claude,
        xdev_vault::Target::Gemini => xdev_export::Target::Gemini,
        xdev_vault::Target::Cursor => xdev_export::Target::Cursor,
    }
}
