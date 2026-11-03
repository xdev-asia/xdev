//! The repos a vault's `covers` prefixes can name, built from the registry.
//! Built fresh for every freshness call: a repo may be added, renamed or
//! moved between two of them.

use std::path::Path;

use xdev_core::{LinkedRepo, Links};
use xdev_git::Repo;
use xdev_workspace::{Registry, RepoEntry, path_key};

/// Whether `key` is `base` or lies under it; both are `path_key` forms.
fn within(key: &str, base: &str) -> bool {
    key == base || key.strip_prefix(base).is_some_and(|r| r.starts_with('/'))
}

/// The repo whose primary checkout, or one of whose recorded worktrees,
/// holds the vault; the longest such path wins.
fn own_repo(reg: &Registry, key: &str) -> Option<String> {
    let primaries = reg.repos.iter().map(|r| (&r.id, &r.path));
    let worktrees = reg.worktrees.iter().map(|m| (&m.repo_id, &m.path));
    let (id, _) = primaries
        .chain(worktrees)
        .map(|(id, path)| (id, path_key(path)))
        .filter(|(_, base)| within(key, base))
        .max_by_key(|(_, base)| base.len())?;
    reg.repos
        .iter()
        .find(|r| &r.id == id)
        .map(|r| r.short_name.clone())
}

/// The repo opened at its primary checkout, or `None` when the folder is
/// gone or git cannot read it: one bad repo must not fail the whole call.
fn linked(entry: &RepoEntry) -> Option<LinkedRepo> {
    if !entry.path.is_dir() {
        return None;
    }
    let repo = Repo::discover(&entry.path).ok()?;
    Some(LinkedRepo {
        repo,
        base_ref: entry.base_ref.clone(),
    })
}

/// A vault registered as shared has no own repo; any other vault belongs to
/// the repo that holds its folder.
pub(crate) fn links_for(reg: &Registry, vault_root: &Path) -> Links {
    let key = path_key(vault_root);
    let shared = reg.vaults.iter().any(|v| path_key(&v.path) == key);
    let own = if shared { None } else { own_repo(reg, &key) };
    let repos = reg
        .repos
        .iter()
        .map(|r| (r.short_name.clone(), linked(r)))
        .collect();
    Links { own, shared, repos }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{add_repo, add_vault, create_worktree};

    use super::*;

    /// Runs setup commands; never used for the code under test.
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    fn make_repo(parent: &Path, name: &str) -> PathBuf {
        let dir = parent.join(name);
        fs::create_dir(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&dir, &["config", key, value]);
        }
        fs::write(dir.join("a.txt"), "one").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        dir
    }

    struct Fixture {
        _tmp: TempDir,
        reg: Registry,
        api: PathBuf,
        web: PathBuf,
        /// A worktree of `api`.
        feature: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = TempDir::with_prefix("links ").unwrap();
        let api = make_repo(tmp.path(), "api");
        let web = make_repo(tmp.path(), "web");
        let mut reg = Registry::default();
        let api_id = add_repo(&mut reg, &api, 0).unwrap().id;
        add_repo(&mut reg, &web, 0).unwrap();
        let feature = create_worktree(&mut reg, &api_id, "feature", None, 1, 1).unwrap();
        Fixture {
            _tmp: tmp,
            reg,
            api,
            web,
            feature: PathBuf::from(feature.path),
        }
    }

    #[test]
    fn links_for_finds_own_repo_from_worktree_vault() {
        let fx = fixture();
        let links = links_for(&fx.reg, &fx.feature.join("docs"));
        assert_eq!(links.own.as_deref(), Some("api"));
        assert!(!links.shared);
        // The primary checkout's docs and the checkout itself match too.
        assert_eq!(
            links_for(&fx.reg, &fx.api.join("docs")).own.as_deref(),
            Some("api")
        );
        assert_eq!(links_for(&fx.reg, &fx.web).own.as_deref(), Some("web"));
        // A folder no repo contains has no own repo.
        let elsewhere = fx._tmp.path().join("notes");
        assert_eq!(links_for(&fx.reg, &elsewhere).own, None);
    }

    #[test]
    fn links_for_marks_shared_vault() {
        let mut fx = fixture();
        // Inside a repo's checkout, yet registered as shared: never a repo vault.
        let shared = fx.api.join("team-docs");
        fs::create_dir(&shared).unwrap();
        add_vault(&mut fx.reg, &shared).unwrap();
        let links = links_for(&fx.reg, &shared);
        assert!(links.shared);
        assert_eq!(links.own, None);
        // Other registered repos are still linkable from it.
        assert!(links.repos.contains_key("web"));
    }

    /// The desktop passes `Vault::root()`, which is canonical (`\\?\E:\…` on
    /// Windows); it must match the plain paths the registry holds.
    #[test]
    fn links_for_matches_a_canonical_vault_root() {
        let mut fx = fixture();
        let shared = fx._tmp.path().join("notes");
        fs::create_dir(&shared).unwrap();
        add_vault(&mut fx.reg, &shared).unwrap();
        let root = xdev_core::Vault::open(&shared).unwrap().root().to_path_buf();
        assert!(links_for(&fx.reg, &root).shared);

        fs::create_dir(fx.feature.join("docs")).unwrap();
        let root = xdev_core::Vault::open(fx.feature.join("docs"))
            .unwrap()
            .root()
            .to_path_buf();
        let links = links_for(&fx.reg, &root);
        assert!(!links.shared);
        assert_eq!(links.own.as_deref(), Some("api"));
    }

    #[test]
    fn links_for_maps_other_repos_by_short_name() {
        let fx = fixture();
        let links = links_for(&fx.reg, &fx.api.join("docs"));
        let names: Vec<_> = links.repos.keys().map(String::as_str).collect();
        assert_eq!(names, ["api", "web"]);
        // Opened at the primary checkout, never at a worktree.
        let api = links.repos["api"].as_ref().unwrap();
        assert_eq!(path_key(&api.repo.root()), path_key(&fx.api));
        let web = links.repos["web"].as_ref().unwrap();
        assert_eq!(path_key(&web.repo.root()), path_key(&fx.web));
        assert_eq!(web.base_ref, fx.reg.repos[1].base_ref);
    }

    #[test]
    fn links_for_missing_repo_is_none() {
        let fx = fixture();
        fs::remove_dir_all(&fx.web).unwrap();
        let links = links_for(&fx.reg, &fx.api.join("docs"));
        assert!(links.repos["web"].is_none());
        assert!(links.repos["api"].is_some());

        // A folder that exists but is not a repo cannot be opened either.
        fs::create_dir(&fx.web).unwrap();
        let links = links_for(&fx.reg, &fx.api.join("docs"));
        assert!(links.repos["web"].is_none());
    }

    #[test]
    fn links_for_picks_the_longest_match() {
        let mut fx = fixture();
        // A repo whose checkout lies inside another's folder wins for its own vault.
        let inner = make_repo(&fx.api, "inner");
        add_repo(&mut fx.reg, &inner, 0).unwrap();
        let links = links_for(&fx.reg, &inner.join("docs"));
        assert_eq!(links.own.as_deref(), Some("inner"));
    }
}
