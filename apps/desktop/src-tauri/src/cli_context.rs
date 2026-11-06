//! `agent.context`: where the caller runs, in one answer: its repo,
//! worktree, tab, PTY and the orchestration run it belongs to.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use xdev_workspace::path_key;

use crate::cli_verbs::{Ctx, params, target};
use crate::endpoint::{AppError, Caller, Request, caller_worktree};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextParams {
    /// `XDEV_WORKTREE_PATH` of the caller's terminal.
    worktree_path: Option<String>,
    /// The caller's folder.
    cwd: Option<String>,
}

/// `agent.context`: the caller's worktree comes from its PTY, else from
/// `worktreePath`, else from the folder it runs in.
pub(crate) fn agent_context(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
) -> Result<Value, AppError> {
    let p: ContextParams = params(req)?;
    let reg = ctx.registry()?;
    let held = |dir: Option<String>| dir.and_then(|d| caller_worktree(&reg, Path::new(&d)));
    let me = match ctx.caller_worktree(caller)? {
        Some(me) => Some(me),
        None => held(p.worktree_path).or_else(|| held(p.cwd)),
    };
    let all = ctx.listed()?;
    let l = target(&all, None, me.as_deref())?;
    let v = &l.view;
    let repo = reg.repos.iter().find(|r| r.id == l.repo_id).map(|r| {
        json!({
            "id": r.id,
            "name": r.short_name,
            "path": r.path.display().to_string(),
        })
    });
    let pty = caller.pty.as_deref();
    let tab = pty.and_then(|id| {
        let (tabs, _) = ctx.board.tabs();
        tabs.into_iter().find(|t| t.id == id).map(|t| {
            json!({
                "id": t.id,
                "title": t.title,
                "kind": if t.agent { "agent" } else { "shell" },
                "profile": t.profile,
                "state": t.state(),
            })
        })
    });
    Ok(json!({
        "repo": repo,
        "worktree": {
            "id": path_key(Path::new(&v.path)),
            "name": v.name,
            "title": v.title,
            "path": v.path,
            "branch": v.branch,
            "primary": v.primary,
        },
        "tab": tab,
        "pty": pty,
        "run": pty.and_then(|id| current_run(ctx, id)),
    }))
}

/// The run tab `id` works in, or the only run; none without a store yet,
/// so asking never creates one.
fn current_run(ctx: &Ctx<'_>, id: &str) -> Option<Value> {
    if !PathBuf::from(ctx.data).join("orchestration.db").is_file() {
        return None;
    }
    let run = ctx
        .orch
        .with_store(ctx.data, |s| s.run_current(Some(id)))
        .ok()?;
    serde_json::to_value(run).ok()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value, json};
    use xdev_workspace::path_key;

    use crate::cli_verbs::tests::{fixture, tab};

    #[test]
    fn context_names_the_repo_worktree_tab_and_no_run() {
        let f = fixture();
        let mut t = tab("p-lead", &f.lead, true, "working");
        t.title = Some("lead agent".to_owned());
        f.board.replace(vec![t], None);
        let c = f.call(Some("p-lead"), "agent.context", json!({})).unwrap();
        assert_eq!(c["repo"]["name"], "main");
        let repo_path = c["repo"]["path"].as_str().unwrap();
        assert_eq!(path_key(Path::new(repo_path)), path_key(&f.main));
        assert!(c["repo"]["id"].is_string());
        assert_eq!(c["worktree"]["id"], path_key(&f.lead));
        assert_eq!(c["worktree"]["name"], "lead");
        assert_eq!(c["worktree"]["primary"], false);
        assert!(c["worktree"]["branch"].is_string());
        assert_eq!(
            c["tab"],
            json!({ "id": "p-lead", "title": "lead agent", "kind": "agent", "profile": "claude", "state": "working" })
        );
        assert_eq!(c["pty"], "p-lead");
        assert_eq!(c["run"], Value::Null);
        // Asking made no orchestration store.
        assert!(!f.data.join("orchestration.db").exists());
    }

    #[test]
    fn context_shows_the_run_of_the_calling_tab() {
        let f = fixture();
        let run = f
            .call(
                Some("p-lead"),
                "orchestration.run-create",
                json!({"objective": "ship"}),
            )
            .unwrap();
        let c = f.call(Some("p-lead"), "agent.context", json!({})).unwrap();
        assert_eq!(c["run"]["id"], run["id"]);
        assert_eq!(c["run"]["objective"], "ship");
        // Not on the board: no tab, still the PTY and the worktree.
        assert_eq!(c["tab"], Value::Null);
        assert_eq!(c["pty"], "p-lead");
    }

    #[test]
    fn context_from_outside_goes_by_the_worktree_path_or_folder() {
        let f = fixture();
        let by_env = f
            .call(
                None,
                "agent.context",
                json!({ "worktreePath": f.other.display().to_string() }),
            )
            .unwrap();
        assert_eq!(by_env["worktree"]["id"], path_key(&f.other));
        assert_eq!(by_env["pty"], Value::Null);
        assert_eq!(by_env["run"], Value::Null);
        let by_cwd = f
            .call(
                None,
                "agent.context",
                json!({ "cwd": f.child.join("src").display().to_string() }),
            )
            .unwrap();
        assert_eq!(by_cwd["worktree"]["id"], path_key(&f.child));
        let main = f
            .call(
                None,
                "agent.context",
                json!({ "cwd": f.main.display().to_string() }),
            )
            .unwrap();
        assert_eq!(main["worktree"]["primary"], true);
        let e = f.call(None, "agent.context", json!({})).unwrap_err();
        assert_eq!(e.code, "no_worktree");
        let e = f
            .call(None, "agent.context", json!({ "cwd": "/nowhere/at/all" }))
            .unwrap_err();
        assert_eq!(e.code, "no_worktree");
    }
}
