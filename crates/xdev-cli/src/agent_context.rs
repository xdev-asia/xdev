//! `xdev agent-context`: where this terminal runs, in one call: repo,
//! worktree, tab, PTY and the orchestration run it belongs to.

use clap::Args;
use serde_json::{Value, json};

use crate::app::text;

/// Set in every xDev terminal.
const WORKTREE_PATH_ENV: &str = "XDEV_WORKTREE_PATH";

#[derive(Args)]
pub struct AgentContextArgs {
    #[arg(long)]
    pub json: bool,
}

/// What `xdev agent-context` sends: method, params and whether to print
/// JSON. The app finds the worktree from the PTY first; the folder from
/// the environment and the working directory are for a caller without one.
pub fn request(a: &AgentContextArgs) -> (&'static str, Value, bool) {
    let worktree = std::env::var(WORKTREE_PATH_ENV)
        .ok()
        .filter(|s| !s.is_empty());
    let cwd = std::env::current_dir()
        .ok()
        .map(|d| d.display().to_string());
    (
        "agent.context",
        json!({ "worktreePath": worktree, "cwd": cwd }),
        a.json,
    )
}

/// The plain text of an `agent.context` answer: one `key<TAB>value` line
/// per field, `-` for none.
pub fn plain(method: &str, r: &Value) -> Option<String> {
    if method != "agent.context" {
        return None;
    }
    let (repo, wt, tab, run) = (&r["repo"], &r["worktree"], &r["tab"], &r["run"]);
    let fields = [
        ("repo", &repo["name"]),
        ("repoId", &repo["id"]),
        ("repoPath", &repo["path"]),
        ("worktree", &wt["name"]),
        ("worktreeId", &wt["id"]),
        ("worktreePath", &wt["path"]),
        ("branch", &wt["branch"]),
        ("tab", &tab["id"]),
        ("tabTitle", &tab["title"]),
        ("state", &tab["state"]),
        ("pty", &r["pty"]),
        ("run", &run["id"]),
        ("runObjective", &run["objective"]),
    ];
    Some(
        fields
            .iter()
            .map(|(k, v)| format!("{k}\t{}\n", text(v)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        command: AgentContextArgs,
    }

    fn parse(args: &[&str]) -> Result<AgentContextArgs, clap::Error> {
        let mut argv = vec!["xdev"];
        argv.extend_from_slice(args);
        Cli::try_parse_from(argv).map(|c| c.command)
    }

    #[test]
    fn context_sends_the_folders_it_knows() {
        let (method, params, json) = request(&parse(&[]).unwrap());
        assert_eq!(method, "agent.context");
        assert!(!json);
        assert!(params["cwd"].is_string());
        assert!(params.get("worktreePath").is_some());
        assert!(request(&parse(&["--json"]).unwrap()).2);
        assert!(parse(&["extra"]).is_err());
    }

    #[test]
    fn plain_context_is_one_key_per_line() {
        let r = json!({
            "repo": { "id": "r1", "name": "app", "path": "/src/app" },
            "worktree": { "id": "/w/a", "name": "a", "title": null, "path": "/w/a", "branch": "feat/a", "primary": false },
            "tab": { "id": "p1", "title": "fix", "kind": "agent", "profile": "claude", "state": "working" },
            "pty": "p1",
            "run": null,
        });
        assert_eq!(
            plain("agent.context", &r).unwrap(),
            "repo\tapp\nrepoId\tr1\nrepoPath\t/src/app\nworktree\ta\nworktreeId\t/w/a\n\
             worktreePath\t/w/a\nbranch\tfeat/a\ntab\tp1\ntabTitle\tfix\nstate\tworking\n\
             pty\tp1\nrun\t-\nrunObjective\t-\n"
        );
        assert_eq!(plain("file.open", &r), None);
    }
}
