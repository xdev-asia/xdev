//! `xdev automations list | show | run | runs | enable | disable | remove`:
//! the scheduled agent runs of the app. The app owns the store; this file maps
//! the verbs to `automation.*` requests and prints the answers.

use clap::Subcommand;
use serde_json::{Value, json};

use crate::app::{AppError, bad_request, text};

/// How many runs `runs` shows without `--limit`.
pub const RUNS_DEFAULT: usize = 10;
/// The most runs one `runs` shows.
pub const RUNS_MAX: usize = 200;

#[derive(Subcommand)]
pub enum AutomationsCommand {
    /// Every automation: `id<TAB>name<TAB>state<TAB>schedule<TAB>nextRunAt<TAB>lastRun`.
    List {
        #[arg(long)]
        json: bool,
    },
    /// One automation, one `key<TAB>value` line per field.
    Show {
        /// Id, a unique prefix of one, or the exact name.
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Queues a run now, paused or not, as Run now does in the app; the
    /// window starts it. Prints `queued<TAB>runId<TAB>status`.
    Run {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// The newest runs: `id<TAB>number<TAB>status<TAB>trigger<TAB>scheduledFor<TAB>finishedAt<TAB>error`.
    Runs {
        id: String,
        /// How many, default 10, at most 200.
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long)]
        json: bool,
    },
    /// Lets the schedule run it.
    Enable {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Stops the schedule; Run still works.
    Disable {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Deletes the automation and its runs.
    Remove {
        id: String,
        /// Confirms the delete.
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
}

/// What one `automations` verb sends: method, params and whether to print JSON.
pub fn request(cmd: &AutomationsCommand) -> Result<(&'static str, Value, bool), AppError> {
    Ok(match cmd {
        AutomationsCommand::List { json } => ("automation.list", json!({}), *json),
        AutomationsCommand::Show { id, json } => ("automation.show", json!({ "id": id }), *json),
        AutomationsCommand::Run { id, json } => ("automation.run", json!({ "id": id }), *json),
        AutomationsCommand::Runs { id, limit, json } => {
            let limit = limit.unwrap_or(RUNS_DEFAULT);
            if !(1..=RUNS_MAX).contains(&limit) {
                return Err(bad_request(format!("--limit is 1 to {RUNS_MAX}")));
            }
            (
                "automation.runs",
                json!({ "id": id, "limit": limit }),
                *json,
            )
        }
        AutomationsCommand::Enable { id, json } => {
            ("automation.enable", json!({ "id": id }), *json)
        }
        AutomationsCommand::Disable { id, json } => {
            ("automation.disable", json!({ "id": id }), *json)
        }
        AutomationsCommand::Remove { id, yes, json } => {
            if !yes {
                return Err(bad_request(format!(
                    "remove deletes the automation and its runs; run `xdev automations remove {id} --yes` to confirm"
                )));
            }
            ("automation.remove", json!({ "id": id }), *json)
        }
    })
}

fn state(a: &Value) -> &'static str {
    if a["enabled"] == true {
        "enabled"
    } else {
        "paused"
    }
}

fn last_run(a: &Value) -> String {
    let run = &a["lastRun"];
    if run.is_null() {
        "-".to_owned()
    } else {
        text(&run["status"])
    }
}

fn list_line(a: &Value) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}\t{}\n",
        text(&a["id"]),
        text(&a["name"]),
        state(a),
        text(&a["rrule"]),
        text(&a["nextRunAt"]),
        last_run(a)
    )
}

fn run_line(r: &Value) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
        text(&r["id"]),
        text(&r["runNumber"]),
        text(&r["status"]),
        text(&r["trigger"]),
        text(&r["scheduledFor"]),
        text(&r["finishedAt"]),
        text(&r["error"])
    )
}

/// The plain text of an `automation.*` answer; none for another method.
pub fn plain(method: &str, result: &Value) -> Option<String> {
    let verb = method.strip_prefix("automation.")?;
    Some(match verb {
        "list" => result
            .as_array()
            .map(|a| a.iter().map(list_line).collect())
            .unwrap_or_default(),
        "show" => {
            let mut out: String = [
                "id",
                "name",
                "agent",
                "repoId",
                "workspaceMode",
                "worktree",
                "timezone",
                "rrule",
                "nextRunAt",
                "lastRunAt",
            ]
            .iter()
            .map(|k| format!("{k}\t{}\n", text(&result[*k])))
            .collect();
            out.push_str(&format!("state\t{}\n", state(result)));
            out.push_str(&format!("lastRun\t{}\n", last_run(result)));
            out
        }
        "run" => format!(
            "queued\t{}\t{}\n",
            text(&result["id"]),
            text(&result["status"])
        ),
        "runs" => result
            .as_array()
            .map(|a| a.iter().map(run_line).collect())
            .unwrap_or_default(),
        "enable" | "disable" => list_line(result),
        "remove" => format!("removed\t{}\n", text(&result["id"])),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: AutomationsCommand,
    }

    fn parse(args: &[&str]) -> Result<AutomationsCommand, clap::Error> {
        let mut argv = vec!["automations"];
        argv.extend_from_slice(args);
        Cli::try_parse_from(argv).map(|c| c.command)
    }

    #[test]
    fn each_verb_maps_to_its_method() {
        let call = |args: &[&str]| request(&parse(args).unwrap()).unwrap();
        assert_eq!(
            call(&["list", "--json"]),
            ("automation.list", json!({}), true)
        );
        assert_eq!(
            call(&["show", "a1"]),
            ("automation.show", json!({ "id": "a1" }), false)
        );
        assert_eq!(call(&["run", "a1"]).0, "automation.run");
        assert_eq!(call(&["enable", "a1"]).0, "automation.enable");
        assert_eq!(call(&["disable", "a1"]).0, "automation.disable");
        assert_eq!(
            call(&["remove", "a1", "--yes"]),
            ("automation.remove", json!({ "id": "a1" }), false)
        );
        assert!(parse(&["show"]).is_err());
        assert!(parse(&["bogus"]).is_err());
    }

    #[test]
    fn runs_takes_a_bounded_limit() {
        let call = |args: &[&str]| request(&parse(args).unwrap());
        assert_eq!(
            call(&["runs", "a1"]).unwrap().1,
            json!({ "id": "a1", "limit": 10 })
        );
        assert_eq!(
            call(&["runs", "a1", "--limit", "3"]).unwrap().1,
            json!({ "id": "a1", "limit": 3 })
        );
        for bad in ["0", "201"] {
            let e = call(&["runs", "a1", "--limit", bad]).unwrap_err();
            assert_eq!(e.exit_code(), 2, "{bad}");
        }
        assert!(parse(&["runs", "a1", "--limit", "-1"]).is_err());
    }

    #[test]
    fn remove_without_yes_is_a_usage_error_with_a_hint() {
        let e = request(&parse(&["remove", "a1"]).unwrap()).unwrap_err();
        assert_eq!(e.exit_code(), 2);
        assert!(e.message.contains("--yes"), "{}", e.message);
        assert!(e.message.contains("a1"));
    }

    #[test]
    fn plain_rows_are_tab_separated() {
        let a = json!({ "id": "a1", "name": "Nightly", "enabled": false, "rrule": "FREQ=DAILY",
            "nextRunAt": 5, "lastRun": { "status": "completed" } });
        assert_eq!(
            plain("automation.list", &json!([a])).unwrap(),
            "a1\tNightly\tpaused\tFREQ=DAILY\t5\tcompleted\n"
        );
        assert_eq!(
            plain("automation.enable", &a).unwrap(),
            "a1\tNightly\tpaused\tFREQ=DAILY\t5\tcompleted\n"
        );
        let runs = json!([{ "id": "r1", "runNumber": 2, "status": "dispatch_failed", "trigger": "manual",
            "scheduledFor": 7, "finishedAt": null, "error": "no window" }]);
        assert_eq!(
            plain("automation.runs", &runs).unwrap(),
            "r1\t2\tdispatch_failed\tmanual\t7\t-\tno window\n"
        );
        let queued = json!({ "id": "r2", "status": "pending" });
        assert_eq!(
            plain("automation.run", &queued).unwrap(),
            "queued\tr2\tpending\n"
        );
        assert_eq!(
            plain("automation.remove", &json!({ "id": "a1" })).unwrap(),
            "removed\ta1\n"
        );
        assert!(
            plain("automation.show", &a)
                .unwrap()
                .contains("state\tpaused\n")
        );
        assert_eq!(plain("status", &a), None);
    }
}
