//! `xdev ports`: the TCP ports listening on this machine, with the process
//! and the worktree each belongs to. The app scans; this file maps the flags
//! to a request and prints the answer as an aligned table.

use clap::Args;
use serde_json::{Value, json};

use crate::app::text;

#[derive(Args)]
pub struct PortsArgs {
    /// Ports of this worktree (id, name or path); default the caller's.
    #[arg(long, conflicts_with = "all")]
    pub worktree: Option<String>,
    /// The ports of every worktree.
    #[arg(long)]
    pub all: bool,
    #[arg(long)]
    pub json: bool,
}

/// What `xdev ports` sends: method, params and whether to print JSON.
pub fn request(a: &PortsArgs) -> (&'static str, Value, bool) {
    (
        "ports.list",
        json!({ "worktree": a.worktree, "all": a.all }),
        a.json,
    )
}

const HEADER: [&str; 4] = ["PORT", "PID", "PROCESS", "WORKTREE"];

/// `rows` under `HEADER`, each column as wide as its widest cell, two spaces
/// between columns and none trailing.
pub fn table(rows: &[[String; 4]]) -> String {
    let mut widths = HEADER.map(str::len);
    for row in rows {
        for (w, cell) in widths.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    let line = |cells: [&str; 4]| {
        let mut out = String::new();
        for (i, cell) in cells.iter().enumerate() {
            if i + 1 == cells.len() {
                out.push_str(cell);
            } else {
                out.push_str(cell);
                out.push_str(&" ".repeat(widths[i] - cell.chars().count() + 2));
            }
        }
        out.push('\n');
        out
    };
    let mut out = line(HEADER);
    for row in rows {
        out.push_str(&line([&row[0], &row[1], &row[2], &row[3]]));
    }
    out
}

/// The plain text of a `ports.list` answer; none for another method.
pub fn plain(method: &str, result: &Value) -> Option<String> {
    if method != "ports.list" {
        return None;
    }
    let ports = result["ports"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if ports.is_empty() {
        return Some(match result["unavailable"].as_str() {
            Some(why) => format!("no port list: {why}\n"),
            None => "no listening ports\n".to_owned(),
        });
    }
    let rows: Vec<[String; 4]> = ports
        .iter()
        .map(|p| {
            let worktree = if p["worktreeName"].is_string() {
                &p["worktreeName"]
            } else {
                &p["worktree"]
            };
            [
                text(&p["port"]),
                text(&p["pid"]),
                text(&p["process"]),
                text(worktree),
            ]
        })
        .collect();
    Some(table(&rows))
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        args: PortsArgs,
    }

    #[test]
    fn the_flags_map_to_params() {
        let a = Cli::try_parse_from(["ports", "--worktree", "/w", "--json"])
            .unwrap()
            .args;
        let (method, params, json) = request(&a);
        assert_eq!(method, "ports.list");
        assert!(json);
        assert_eq!(params, json!({ "worktree": "/w", "all": false }));
        let a = Cli::try_parse_from(["ports", "--all"]).unwrap().args;
        assert_eq!(request(&a).1, json!({ "worktree": null, "all": true }));
        assert!(Cli::try_parse_from(["ports", "--all", "--worktree", "x"]).is_err());
    }

    #[test]
    fn the_table_is_aligned_with_no_trailing_space() {
        let r = json!({ "ports": [
            { "port": 5173, "pid": 42, "process": "node", "worktree": "/r/a", "worktreeName": "a" },
            { "port": 80, "pid": null, "process": null, "worktree": null, "worktreeName": null },
        ] });
        assert_eq!(
            plain("ports.list", &r).unwrap(),
            "PORT  PID  PROCESS  WORKTREE\n5173  42   node     a\n80    -    -        -\n"
        );
    }

    #[test]
    fn an_empty_answer_says_why() {
        assert_eq!(
            plain("ports.list", &json!({ "ports": [], "unavailable": null })).unwrap(),
            "no listening ports\n"
        );
        assert_eq!(
            plain(
                "ports.list",
                &json!({ "ports": [], "unavailable": "no_terminal" })
            )
            .unwrap(),
            "no port list: no_terminal\n"
        );
        assert_eq!(plain("status", &json!({})), None);
    }
}
