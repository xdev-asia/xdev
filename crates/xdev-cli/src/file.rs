//! `xdev file open <path>`: shows a file in the xDev window. The app resolves
//! the path to a worktree; only parsing and the text of the answer live here.

use clap::Subcommand;
use serde_json::{Value, json};

use crate::app::text;

#[derive(Subcommand)]
pub enum FileCommand {
    /// Opens a file in the xDev window and brings the window to the front.
    /// `path:line` and `path:line:column` work too; the file must be inside
    /// a worktree xDev knows. Prints `opened<TAB>worktree<TAB>path<TAB>line<TAB>column`.
    Open {
        /// Absolute, or relative to the current folder.
        path: String,
        /// Line to put the cursor on (1-based).
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        line: Option<u32>,
        /// Column to put the cursor on (1-based).
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        column: Option<u32>,
        #[arg(long)]
        json: bool,
    },
    /// Opens every changed file of a worktree (default: the caller's) in
    /// the xDev window, at most 20. Prints `opened<TAB>path` per file and
    /// `skipped<TAB>path<TAB>reason` for deleted files and the rest.
    OpenChanged {
        /// Id, unique prefix, name or path of the worktree.
        #[arg(long)]
        worktree: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

/// What one `file` verb sends: method, params and whether to print JSON.
pub fn request(cmd: &FileCommand) -> (&'static str, Value, bool) {
    let cwd = || {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    };
    match cmd {
        FileCommand::OpenChanged { worktree, json } => (
            "file.open-changed",
            json!({ "worktree": worktree, "cwd": cwd() }),
            *json,
        ),
        FileCommand::Open {
            path,
            line,
            column,
            json,
        } => (
            "file.open",
            json!({ "path": path, "line": line, "column": column, "cwd": cwd() }),
            *json,
        ),
    }
}

/// The plain text of a `file.*` answer.
pub fn plain(method: &str, result: &Value) -> Option<String> {
    match method {
        "file.open" => Some(format!(
            "opened\t{}\t{}\t{}\t{}\n",
            text(&result["worktree"]),
            text(&result["path"]),
            text(&result["line"]),
            text(&result["column"])
        )),
        "file.open-changed" => {
            let list = |k: &str| result[k].as_array().map(Vec::as_slice).unwrap_or_default();
            let opened = list("opened").iter().map(|p| {
                format!(
                    "opened	{}
",
                    text(p)
                )
            });
            let skipped = list("skipped").iter().map(|s| {
                format!(
                    "skipped	{}	{}
",
                    text(&s["path"]),
                    text(&s["reason"])
                )
            });
            Some(opened.chain(skipped).collect())
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
        command: FileCommand,
    }

    fn parse(args: &[&str]) -> Result<FileCommand, clap::Error> {
        let mut argv = vec!["xdev", "open"];
        argv.extend_from_slice(args);
        Cli::try_parse_from(argv).map(|c| c.command)
    }

    #[test]
    fn open_maps_the_path_and_position() {
        let cmd = parse(&["src/a.rs:3", "--line", "9", "--column", "2"]).unwrap();
        let (method, params, json) = request(&cmd);
        assert_eq!(method, "file.open");
        assert!(!json);
        assert_eq!(params["path"], "src/a.rs:3");
        assert_eq!(params["line"], 9);
        assert_eq!(params["column"], 2);
        assert!(params["cwd"].is_string());
    }

    #[test]
    fn open_needs_a_path_and_a_positive_position() {
        assert!(parse(&[]).is_err());
        assert!(parse(&["a", "--line", "0"]).is_err());
        assert!(parse(&["a", "--column", "x"]).is_err());
        let (_, params, json) = request(&parse(&["a", "--json"]).unwrap());
        assert!(json);
        assert_eq!(params["line"], Value::Null);
    }

    #[test]
    fn open_changed_takes_a_worktree_or_none() {
        let cli = |args: &[&str]| {
            let mut argv = vec!["xdev", "open-changed"];
            argv.extend_from_slice(args);
            Cli::try_parse_from(argv).map(|c| request(&c.command))
        };
        let (method, params, json) = cli(&[]).unwrap();
        assert_eq!(method, "file.open-changed");
        assert!(!json);
        assert_eq!(params["worktree"], Value::Null);
        assert!(params["cwd"].is_string());
        let (_, params, json) = cli(&["--worktree", "lead", "--json"]).unwrap();
        assert!(json);
        assert_eq!(params["worktree"], "lead");
        assert!(cli(&["a.rs"]).is_err());
    }

    #[test]
    fn plain_open_changed_lists_opened_then_skipped() {
        let r = json!({
            "worktree": "/w",
            "opened": ["a.rs", "src/b.rs"],
            "skipped": [{ "path": "gone.rs", "reason": "deleted" }],
        });
        assert_eq!(
            plain("file.open-changed", &r).unwrap(),
            "opened	a.rs
opened	src/b.rs
skipped	gone.rs	deleted
"
        );
        let none = json!({ "worktree": "/w", "opened": [], "skipped": [] });
        assert_eq!(plain("file.open-changed", &none).unwrap(), "");
    }

    #[test]
    fn plain_open_is_one_tab_separated_line() {
        let r = json!({ "worktree": "/w", "path": "src/a.rs", "line": 3, "column": null });
        assert_eq!(
            plain("file.open", &r).unwrap(),
            "opened\t/w\tsrc/a.rs\t3\t-\n"
        );
        assert_eq!(plain("ports.list", &r), None);
    }
}
