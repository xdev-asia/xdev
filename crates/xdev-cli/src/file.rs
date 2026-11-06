//! `xdev file open|open-changed|diff`: shows files in the xDev window. The
//! app resolves the path to a worktree; parsing, the text of the answer and
//! `diff --print`, which needs no app, live here.

use std::io::{self, Write};
use std::path::Path;
use std::process::Command;

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
    /// Shows a file's changes in the review tab of its worktree and brings
    /// the window to the front. Prints `opened<TAB>worktree<TAB>path<TAB>base`.
    /// `--print` writes the unified diff here instead; the app is not needed.
    Diff {
        /// Absolute, or relative to the current folder.
        path: String,
        /// Only what is staged: the index against `HEAD` (or `--against`). Needs `--print`;
        /// the review tab shows the working tree.
        #[arg(long)]
        staged: bool,
        /// The ref to compare with.
        #[arg(long, value_name = "REF")]
        against: Option<String>,
        /// Print the unified diff (`git diff`) instead of opening the app.
        #[arg(long, conflicts_with = "json")]
        print: bool,
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
        FileCommand::Diff {
            path,
            staged,
            against,
            json,
            ..
        } => (
            "file.diff",
            json!({ "path": path, "staged": staged, "against": against, "cwd": cwd() }),
            *json,
        ),
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
        "file.diff" => Some(format!(
            "opened\t{}\t{}\t{}\n",
            text(&result["worktree"]),
            text(&result["path"]),
            text(&result["base"])
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

/// The arguments of `git` for `file diff --print`: `diff [--cached] [<ref>]
/// -- <path>`. A ref that is empty, starts with `-` or holds a control
/// character is refused, so it cannot pass as an option.
pub fn diff_args(path: &str, staged: bool, against: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec![
        "diff".to_owned(),
        "--no-color".to_owned(),
        "--no-ext-diff".to_owned(),
    ];
    if staged {
        args.push("--cached".to_owned());
    }
    if let Some(name) = against.map(str::trim) {
        if name.is_empty() || name.starts_with('-') || name.chars().any(char::is_control) {
            return Err(format!("{name:?} is not a ref"));
        }
        args.push(name.to_owned());
    }
    if path.trim().is_empty() {
        return Err("name a file to diff".to_owned());
    }
    args.push("--".to_owned());
    args.push(path.to_owned());
    Ok(args)
}

/// `file diff --print`: runs git in `cwd` and writes its diff to `out`. The
/// exit code is git's; a refused argument is 2, git not found is 1.
pub fn print_diff(
    cwd: &Path,
    path: &str,
    staged: bool,
    against: Option<&str>,
    out: &mut dyn Write,
) -> u8 {
    let args = match diff_args(path, staged, against) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: bad_request: {e}");
            return 2;
        }
    };
    let run = Command::new("git").args(&args).current_dir(cwd).output();
    let output = match run {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: git: {e}");
            return 1;
        }
    };
    let _ = io::stderr().write_all(&output.stderr);
    if out
        .write_all(&output.stdout)
        .and_then(|()| out.flush())
        .is_err()
    {
        return 1;
    }
    match output.status.code() {
        Some(0) => 0,
        Some(c) => u8::try_from(c).unwrap_or(1).max(1),
        None => 1,
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

    #[test]
    fn diff_maps_its_flags_and_print_shuts_out_json() {
        let cli = |args: &[&str]| {
            let mut argv = vec!["xdev", "diff"];
            argv.extend_from_slice(args);
            Cli::try_parse_from(argv).map(|c| c.command)
        };
        let (method, params, json) =
            request(&cli(&["src/a.rs", "--staged", "--against", "main", "--json"]).unwrap());
        assert_eq!(method, "file.diff");
        assert!(json);
        assert_eq!(params["path"], "src/a.rs");
        assert_eq!(params["staged"], true);
        assert_eq!(params["against"], "main");
        assert!(params["cwd"].is_string());
        let (_, params, json) = request(&cli(&["a.rs"]).unwrap());
        assert!(!json);
        assert_eq!(params["staged"], false);
        assert_eq!(params["against"], Value::Null);
        assert!(matches!(
            cli(&["a.rs", "--print"]).unwrap(),
            FileCommand::Diff { print: true, .. }
        ));
        assert!(cli(&[]).is_err());
        assert!(cli(&["a.rs", "--print", "--json"]).is_err());
    }

    #[test]
    fn diff_args_keep_a_ref_from_passing_as_an_option() {
        assert_eq!(
            diff_args("a.rs", false, None).unwrap(),
            ["diff", "--no-color", "--no-ext-diff", "--", "a.rs"]
        );
        assert_eq!(
            diff_args("a.rs", true, Some(" main ")).unwrap(),
            [
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--cached",
                "main",
                "--",
                "a.rs"
            ]
        );
        for bad in ["", "--output=x", "a\nb"] {
            assert!(diff_args("a.rs", false, Some(bad)).is_err(), "{bad:?}");
        }
        assert!(diff_args(" ", false, None).is_err());
    }

    #[test]
    fn print_writes_git_s_diff_without_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "first"]);
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let mut out = Vec::new();
        assert_eq!(print_diff(dir.path(), "a.txt", false, None, &mut out), 0);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("-one") && text.contains("+two"), "{text}");
        // Nothing staged yet.
        let mut out = Vec::new();
        assert_eq!(print_diff(dir.path(), "a.txt", true, None, &mut out), 0);
        assert!(out.is_empty());
        git(&["add", "a.txt"]);
        let mut out = Vec::new();
        assert_eq!(
            print_diff(dir.path(), "a.txt", true, Some("HEAD"), &mut out),
            0
        );
        assert!(String::from_utf8(out).unwrap().contains("+two"));
        let mut out = Vec::new();
        assert_ne!(
            print_diff(dir.path(), "a.txt", false, Some("no-such-ref"), &mut out),
            0
        );
        assert_eq!(
            print_diff(dir.path(), "a.txt", false, Some("-x"), &mut out),
            2
        );
    }

    #[test]
    fn plain_diff_is_one_tab_separated_line() {
        let r = json!({ "worktree": "/w", "path": "src/a.rs", "base": null });
        assert_eq!(plain("file.diff", &r).unwrap(), "opened\t/w\tsrc/a.rs\t-\n");
    }
}
