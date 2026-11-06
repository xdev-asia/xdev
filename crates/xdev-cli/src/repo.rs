//! `xdev repo`: the repos the running app tracks. `list` and `show` read;
//! `add`, `set` and `set-base-ref` change the sidebar, so the app may ask
//! the person first.

use std::path::Path;

use clap::Subcommand;
use serde_json::{Value, json};

use crate::app::text;

#[derive(Subcommand)]
pub enum RepoCommand {
    /// Every repo: `name<TAB>baseRef<TAB>worktrees<TAB>path`.
    List {
        #[arg(long)]
        json: bool,
    },
    /// One repo (id, short name or path; default the caller's) with its
    /// worktrees.
    Show {
        repo: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Starts tracking the repo that holds `path`, with the worktrees git
    /// already lists.
    Add {
        path: String,
        #[arg(long)]
        json: bool,
    },
    /// Changes a repo's settings (default: the caller's repo). Existing
    /// worktrees are neither moved nor renamed.
    Set {
        /// Id, short name or path of the repo.
        #[arg(long)]
        repo: Option<String>,
        /// The short name: `[a-z0-9]` first, then `[a-z0-9._-]`, at most 40.
        #[arg(long, visible_alias = "display-name")]
        name: Option<String>,
        /// The folder new worktrees go under.
        #[arg(long)]
        worktree_root: Option<String>,
        /// The docs folder, relative to the primary checkout; empty for `docs`.
        #[arg(long)]
        docs_dir: Option<String>,
        /// A palette name or `#rgb`/`#rrggbb`; `none` clears it.
        #[arg(long)]
        color: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// The ref new worktrees start from and are compared with.
    SetBaseRef {
        #[arg(value_name = "REF")]
        base_ref: String,
        /// Id, short name or path of the repo; default the caller's.
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

/// `path` as given when absolute, else under the current folder: the app
/// does not know where the CLI runs.
fn absolute(path: &str) -> String {
    std::path::absolute(Path::new(path))
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.to_owned())
}

/// What `xdev repo` sends: method, params and whether to print JSON.
pub fn request(c: &RepoCommand) -> (&'static str, Value, bool) {
    match c {
        RepoCommand::List { json } => ("repo.list", json!({}), *json),
        RepoCommand::Show { repo, json } => ("repo.show", json!({ "repo": repo }), *json),
        RepoCommand::Add { path, json } => ("repo.add", json!({ "path": absolute(path) }), *json),
        RepoCommand::Set {
            repo,
            name,
            worktree_root,
            docs_dir,
            color,
            json,
        } => (
            "repo.set",
            json!({
                "repo": repo,
                "name": name,
                "worktreeRoot": worktree_root.as_deref().map(absolute),
                "docsDir": docs_dir,
                "color": color,
            }),
            *json,
        ),
        RepoCommand::SetBaseRef {
            base_ref,
            repo,
            json,
        } => (
            "repo.set-base-ref",
            json!({ "repo": repo, "ref": base_ref }),
            *json,
        ),
    }
}

/// The plain text of a `repo.*` answer.
pub fn plain(method: &str, r: &Value) -> Option<String> {
    match method {
        "repo.list" => Some(
            r.as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(|row| {
                    format!(
                        "{}\t{}\t{}\t{}\n",
                        text(&row["name"]),
                        text(&row["baseRef"]),
                        text(&row["worktrees"]),
                        text(&row["path"]),
                    )
                })
                .collect(),
        ),
        "repo.show" | "repo.add" | "repo.set" | "repo.set-base-ref" => {
            let mut out: String = [
                "id",
                "name",
                "path",
                "baseRef",
                "worktreeRoot",
                "docsDir",
                "color",
                "missing",
            ]
            .iter()
            .map(|k| format!("{k}\t{}\n", text(&r[*k])))
            .collect();
            for w in r["worktrees"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                out.push_str(&format!(
                    "worktree\t{}\t{}\t{}\n",
                    text(&w["name"]),
                    text(&w["branch"]),
                    text(&w["path"]),
                ));
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: RepoCommand,
    }

    fn repo(args: &[&str]) -> Result<(&'static str, Value, bool), clap::Error> {
        let mut argv = vec!["repo"];
        argv.extend_from_slice(args);
        Cli::try_parse_from(argv).map(|c| request(&c.command))
    }

    #[test]
    fn each_verb_maps_to_its_method() {
        assert_eq!(repo(&["list"]).unwrap(), ("repo.list", json!({}), false));
        assert_eq!(
            repo(&["show", "app", "--json"]).unwrap(),
            ("repo.show", json!({ "repo": "app" }), true)
        );
        assert_eq!(
            repo(&["show"]).unwrap(),
            ("repo.show", json!({ "repo": null }), false)
        );
        assert_eq!(
            repo(&["set-base-ref", "origin/dev", "--repo", "app"]).unwrap(),
            (
                "repo.set-base-ref",
                json!({ "repo": "app", "ref": "origin/dev" }),
                false
            )
        );
        assert!(repo(&["set-base-ref"]).is_err());
        assert!(repo(&["add"]).is_err());
    }

    #[test]
    fn add_and_worktree_root_go_out_absolute() {
        let (method, params, _) = repo(&["add", "web"]).unwrap();
        assert_eq!(method, "repo.add");
        let path = params["path"].as_str().unwrap();
        assert!(Path::new(path).is_absolute(), "{path}");
        assert!(path.ends_with("web"));

        let (method, params, json) = repo(&[
            "set",
            "--repo",
            "app",
            "--display-name",
            "api",
            "--worktree-root",
            "trees",
            "--docs-dir",
            "notes",
            "--color",
            "none",
            "--json",
        ])
        .unwrap();
        assert_eq!(method, "repo.set");
        assert!(json);
        assert_eq!(params["repo"], "app");
        assert_eq!(params["name"], "api");
        assert_eq!(params["docsDir"], "notes");
        assert_eq!(params["color"], "none");
        assert!(Path::new(params["worktreeRoot"].as_str().unwrap()).is_absolute());

        let (_, params, _) = repo(&["set", "--name", "api"]).unwrap();
        assert_eq!(
            params,
            json!({ "repo": null, "name": "api", "worktreeRoot": null, "docsDir": null, "color": null })
        );
        assert!(repo(&["set", "--name", "a", "--display-name", "b"]).is_err());
    }

    #[test]
    fn plain_lists_rows_and_shows_one_key_per_line() {
        let rows = json!([
            { "id": "r1", "name": "app", "path": "/src/app", "baseRef": "main", "missing": false, "worktrees": 3 },
        ]);
        assert_eq!(
            plain("repo.list", &rows).unwrap(),
            "app\tmain\t3\t/src/app\n"
        );
        let one = json!({
            "id": "r1", "name": "app", "path": "/src/app", "baseRef": "main",
            "worktreeRoot": "/trees/app", "docsDir": "docs", "color": null, "missing": false,
            "worktrees": [
                { "id": "/src/app", "name": "app", "branch": "main", "path": "/src/app", "primary": true },
                { "id": "/trees/app/a", "name": "a", "branch": null, "path": "/trees/app/a", "primary": false },
            ],
        });
        let shown = "id\tr1\nname\tapp\npath\t/src/app\nbaseRef\tmain\nworktreeRoot\t/trees/app\n\
                     docsDir\tdocs\ncolor\t-\nmissing\tfalse\n\
                     worktree\tapp\tmain\t/src/app\nworktree\ta\t-\t/trees/app/a\n";
        for method in ["repo.show", "repo.add", "repo.set", "repo.set-base-ref"] {
            assert_eq!(plain(method, &one).unwrap(), shown, "{method}");
        }
        assert_eq!(plain("file.open", &one), None);
    }
}
