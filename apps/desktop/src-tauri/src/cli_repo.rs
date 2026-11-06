//! `repo.*`: the repos the sidebar tracks, as the CLI sees and edits them.
//! `list` and `show` read; `add`, `set` and `set-base-ref` write through
//! the policy gate, then tell the window to reload.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use xdev_workspace::{RepoPatch, RepoView, add_repo, list, path_key, update_repo};

use crate::cli_verbs::{Ctx, bad_request, params};
use crate::endpoint::{AppError, Caller, Request, scope_of};
use crate::workspace::update;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowParams {
    /// Id, short name or path; default the caller's repo.
    repo: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddParams {
    /// An absolute folder inside the repo.
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetParams {
    repo: Option<String>,
    /// The short name.
    name: Option<String>,
    /// An absolute folder new worktrees go under.
    worktree_root: Option<String>,
    /// Relative to the primary checkout; empty goes back to `docs`.
    docs_dir: Option<String>,
    /// A palette name or `#rgb`/`#rrggbb`; `none` clears it.
    color: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaseRefParams {
    repo: Option<String>,
    #[serde(rename = "ref")]
    base_ref: String,
}

pub fn handle(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    match req.method.as_str() {
        "repo.list" => {
            let repos = repos(ctx)?;
            Ok(Value::Array(repos.iter().map(row).collect()))
        }
        "repo.show" => {
            let p: ShowParams = params(req)?;
            let repos = repos(ctx)?;
            let me = ctx.caller_worktree(caller)?;
            Ok(detail(find(&repos, p.repo.as_deref(), me.as_deref())?))
        }
        "repo.add" => repo_add(ctx, req, caller),
        "repo.set" => {
            let p: SetParams = params(req)?;
            let color = p.color.map(|c| if c == "none" { None } else { Some(c) });
            let patch = RepoPatch {
                short_name: p.name,
                worktree_root: p.worktree_root.map(PathBuf::from),
                docs_dir: p.docs_dir,
                color,
                ..RepoPatch::default()
            };
            if patch.short_name.is_none()
                && patch.worktree_root.is_none()
                && patch.docs_dir.is_none()
                && patch.color.is_none()
            {
                return Err(bad_request("nothing to set"));
            }
            write(ctx, caller, "repo.set", "set", p.repo.as_deref(), patch)
        }
        "repo.set-base-ref" => {
            let p: BaseRefParams = params(req)?;
            if p.base_ref.trim().is_empty() {
                return Err(bad_request("the base ref is empty"));
            }
            let patch = RepoPatch {
                base_ref: Some(p.base_ref),
                ..RepoPatch::default()
            };
            let verb = "repo.set-base-ref";
            write(ctx, caller, verb, "set-base-ref", p.repo.as_deref(), patch)
        }
        other => Err(bad_request(format!("unknown method {other}"))),
    }
}

/// Every repo, brought in line with git, as the sidebar does.
fn repos(ctx: &Ctx<'_>) -> Result<Vec<RepoView>, AppError> {
    Ok(update(ctx.data, ctx.lock, list)?)
}

/// The repo `named` (id, short name or path), else the one holding `me`.
fn find<'a>(
    repos: &'a [RepoView],
    named: Option<&str>,
    me: Option<&Path>,
) -> Result<&'a RepoView, AppError> {
    let no_repo = |m: String| AppError::new("no_repo", m);
    match named {
        Some(n) => {
            let key = path_key(Path::new(n));
            repos
                .iter()
                .find(|r| r.id == n || r.short_name == n)
                .or_else(|| repos.iter().find(|r| path_key(Path::new(&r.path)) == key))
                .ok_or_else(|| no_repo(format!("no repo {n}")))
        }
        None => {
            let me = me.ok_or_else(|| no_repo("not in a repo; name one".to_owned()))?;
            let key = path_key(me);
            repos
                .iter()
                .find(|r| {
                    r.worktrees
                        .iter()
                        .any(|w| path_key(Path::new(&w.path)) == key)
                })
                .ok_or_else(|| no_repo("not in a repo; name one".to_owned()))
        }
    }
}

fn row(r: &RepoView) -> Value {
    json!({
        "id": r.id,
        "name": r.short_name,
        "path": r.path,
        "baseRef": r.base_ref,
        "missing": r.missing,
        "worktrees": r.worktrees.len(),
    })
}

fn detail(r: &RepoView) -> Value {
    let worktrees: Vec<Value> = r
        .worktrees
        .iter()
        .map(|w| {
            json!({
                "id": path_key(Path::new(&w.path)),
                "name": w.name,
                "branch": w.branch,
                "path": w.path,
                "primary": w.primary,
            })
        })
        .collect();
    json!({
        "id": r.id,
        "name": r.short_name,
        "path": r.path,
        "baseRef": r.base_ref,
        "worktreeRoot": r.worktree_root,
        "docsDir": r.docs_dir,
        "color": r.color,
        "missing": r.missing,
        "worktrees": worktrees,
    })
}

/// `repo.add`: asks unless the caller runs in that very folder.
fn repo_add(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: AddParams = params(req)?;
    let path = PathBuf::from(&p.path);
    if !path.is_absolute() {
        return Err(bad_request(format!("{} is not an absolute path", p.path)));
    }
    let me = ctx.caller_worktree(caller)?;
    let scope = scope_of(me.as_deref(), &path, &ctx.registry()?);
    ctx.gate("repo.add", "add", me.as_deref(), &path, scope)?;
    let view = update(ctx.data, ctx.lock, |reg| add_repo(reg, &path, ctx.now_ms))?;
    (ctx.emit)("workspace://changed", Value::Null);
    Ok(detail(&view))
}

/// A settings write: the primary checkout's own terminals pass, any
/// other caller asks.
fn write(
    ctx: &Ctx<'_>,
    caller: &Caller,
    verb: &str,
    op: &str,
    named: Option<&str>,
    patch: RepoPatch,
) -> Result<Value, AppError> {
    let me = ctx.caller_worktree(caller)?;
    let (id, path) = {
        let repos = repos(ctx)?;
        let r = find(&repos, named, me.as_deref())?;
        (r.id.clone(), PathBuf::from(&r.path))
    };
    let scope = scope_of(me.as_deref(), &path, &ctx.registry()?);
    ctx.gate(verb, op, me.as_deref(), &path, scope)?;
    let view = update(ctx.data, ctx.lock, |reg| update_repo(reg, &id, patch))?;
    (ctx.emit)("workspace://changed", Value::Null);
    Ok(detail(&view))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::{Value, json};
    use xdev_workspace::path_key;

    use crate::cli_verbs::tests::{fixture, git};

    fn changed(f: &crate::cli_verbs::tests::Fixture) -> usize {
        f.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "workspace://changed")
            .count()
    }

    fn key(v: &Value) -> String {
        path_key(Path::new(v.as_str().unwrap()))
    }

    #[test]
    fn list_and_show_name_the_repo_and_its_worktrees() {
        let f = fixture();
        let rows = f.call(None, "repo.list", json!({})).unwrap();
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "main");
        assert_eq!(rows[0]["worktrees"], 4);
        assert_eq!(rows[0]["missing"], false);
        assert_eq!(key(&rows[0]["path"]), path_key(&f.main));

        let mine = f.call(Some("p-lead"), "repo.show", json!({})).unwrap();
        assert_eq!(mine["id"], rows[0]["id"]);
        assert!(mine["baseRef"].is_string());
        assert_eq!(mine["docsDir"], "docs");
        let names: Vec<&str> = mine["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"lead") && names.contains(&"child"));

        for named in [
            "main".to_owned(),
            rows[0]["id"].as_str().unwrap().to_owned(),
            f.main.display().to_string(),
        ] {
            let r = f.call(None, "repo.show", json!({ "repo": named })).unwrap();
            assert_eq!(r["id"], rows[0]["id"], "{named}");
        }
        let e = f.call(None, "repo.show", json!({})).unwrap_err();
        assert_eq!(e.code, "no_repo");
        let e = f
            .call(None, "repo.show", json!({ "repo": "nope" }))
            .unwrap_err();
        assert_eq!(e.code, "no_repo");
    }

    #[test]
    fn add_asks_then_tracks_the_repo_once() {
        let mut f = fixture();
        let tmp = crate::test_dirs::long_temp_dir("cli repo ");
        let web = tmp.path().join("web");
        fs::create_dir(&web).unwrap();
        git(&web, &["init", "-q"]);
        git(&web, &["config", "user.name", "Test User"]);
        git(&web, &["config", "user.email", "test@example.com"]);
        git(&web, &["config", "commit.gpgsign", "false"]);
        fs::write(web.join("a.txt"), "one").unwrap();
        git(&web, &["add", "-A"]);
        git(&web, &["commit", "-q", "-m", "one"]);
        let path = web.display().to_string();

        let e = f
            .call(None, "repo.add", json!({ "path": "web" }))
            .unwrap_err();
        assert_eq!(e.code, "bad_request");
        // Nobody answers: nothing is added.
        let e = f
            .call(None, "repo.add", json!({ "path": path }))
            .unwrap_err();
        assert_eq!(e.code, "needs_approval");
        assert_eq!(
            f.call(None, "repo.list", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        f.answer = Some(true);
        let added = f
            .call(Some("p-lead"), "repo.add", json!({ "path": path }))
            .unwrap();
        assert_eq!(added["name"], "web");
        assert_eq!(key(&added["path"]), path_key(&web));
        assert_eq!(changed(&f), 1);
        assert_eq!(
            f.call(None, "repo.list", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let e = f
            .call(Some("p-lead"), "repo.add", json!({ "path": path }))
            .unwrap_err();
        assert_eq!(e.code, "repo_exists");
    }

    #[test]
    fn set_renames_colours_and_moves_the_worktree_root() {
        let mut f = fixture();
        let e = f.call(Some("p-lead"), "repo.set", json!({})).unwrap_err();
        assert_eq!(e.code, "bad_request");
        // A worktree is not the repo: it asks, and silence refuses.
        let e = f
            .call(Some("p-lead"), "repo.set", json!({ "name": "app" }))
            .unwrap_err();
        assert_eq!(e.code, "needs_approval");
        assert_eq!(changed(&f), 0);

        f.answer = Some(true);
        let root = f.data.join("trees");
        let colour = xdev_workspace::REPO_COLORS[0];
        let r = f
            .call(
                Some("p-lead"),
                "repo.set",
                json!({ "name": "app", "color": colour, "worktreeRoot": root.display().to_string() }),
            )
            .unwrap();
        assert_eq!(r["name"], "app");
        assert_eq!(r["color"], colour);
        assert_eq!(key(&r["worktreeRoot"]), path_key(&root));
        assert_eq!(changed(&f), 1);

        let r = f
            .call(None, "repo.set", json!({ "repo": "app", "color": "none" }))
            .unwrap();
        assert_eq!(r["color"], Value::Null);
        assert_eq!(r["name"], "app");

        let e = f
            .call(
                None,
                "repo.set",
                json!({ "repo": "app", "name": "Bad Name" }),
            )
            .unwrap_err();
        assert_eq!(e.code, "bad_name");
        let e = f
            .call(None, "repo.set", json!({ "repo": "app", "color": "nope" }))
            .unwrap_err();
        assert_eq!(e.code, "bad_color");
        assert_eq!(changed(&f), 2);
    }

    #[test]
    fn set_base_ref_takes_a_ref_git_knows() {
        let mut f = fixture();
        f.answer = Some(true);
        git(&f.main, &["branch", "dev"]);
        let r = f
            .call(
                Some("p-other"),
                "repo.set-base-ref",
                json!({ "ref": "dev" }),
            )
            .unwrap();
        assert_eq!(r["baseRef"], "dev");
        let e = f
            .call(
                None,
                "repo.set-base-ref",
                json!({ "repo": "main", "ref": "no-such-branch" }),
            )
            .unwrap_err();
        assert_eq!(e.code, "bad_ref");
        let e = f
            .call(
                None,
                "repo.set-base-ref",
                json!({ "repo": "main", "ref": " " }),
            )
            .unwrap_err();
        assert_eq!(e.code, "bad_request");
        let shown = f
            .call(None, "repo.show", json!({ "repo": "main" }))
            .unwrap();
        assert_eq!(shown["baseRef"], "dev");
    }
}
