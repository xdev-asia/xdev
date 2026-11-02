use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Subcommand;
use xdev_agent::{
    AgentError, ClaudeRunner, CodexRunner, RunOptions, Runner, Task, TaskState, TaskStore,
};
use xdev_ai::{Provider, Registry};
use xdev_policy::{Audited, Policy, Verdict};

use crate::Outcome;

/// Long enough for a real change; a hung agent still ends.
const RUN_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Exit code when the gate stopped a step, apart from errors (1).
const GATED: u8 = 3;

#[derive(Subcommand)]
pub enum TaskCommand {
    /// Make a task on a new branch and worktree from the repo's `HEAD`;
    /// prints its id.
    New { repo: PathBuf, goal: String },
    /// Run the agent, commit its changes and run the test; prints the task.
    /// Exits 3 with `ask` or `deny` and a reason when the policy stops it.
    Run {
        id: String,
        /// A registered account; default is your own Claude Code config.
        #[arg(long)]
        account: Option<String>,
        /// Test command run in the worktree afterwards, split on whitespace.
        #[arg(long)]
        test: Option<String>,
        /// Tools the agent may use, comma-separated.
        #[arg(
            long,
            value_delimiter = ',',
            default_value = "Read,Edit,Write,Grep,Glob"
        )]
        tools: Vec<String>,
    },
    /// Continue the last agent session of a paused or failed task.
    Resume {
        id: String,
        #[arg(long)]
        account: Option<String>,
    },
    /// Print a task as `key<TAB>value` lines.
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Print `id<TAB>state<TAB>goal` per task, newest first.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Merge the task branch into the repo's current branch; prints the
    /// merge commit.
    Approve { id: String },
    /// Remove the task's worktree and branch.
    Discard { id: String },
}

pub fn run(command: TaskCommand, data_dir: &Path) -> Result<Outcome, &'static str> {
    let store = TaskStore::new(data_dir);
    // The person's policy file decides; every verdict lands in the audit log.
    let gate = Audited::new(Policy::load(data_dir).map_err(|e| e.code())?, data_dir);
    let result = match command {
        TaskCommand::New { repo, goal } => {
            let task = store.new_task(&repo, &goal).map_err(code)?;
            println!("{}", task.id);
            return Ok(Outcome::Ok);
        }
        TaskCommand::Run {
            id,
            account,
            test,
            tools,
        } => {
            let runner = runner(data_dir, account.as_deref())?;
            let opts = RunOptions {
                account,
                tools: tools.into_iter().filter(|t| !t.is_empty()).collect(),
                test: test.map(|t| t.split_whitespace().map(str::to_owned).collect()),
            };
            store.run_task(&id, &*runner, &gate, &opts)
        }
        TaskCommand::Resume { id, account } => {
            let runner = runner(data_dir, account.as_deref())?;
            let opts = RunOptions {
                account,
                ..RunOptions::default()
            };
            store.resume_task(&id, &*runner, &gate, &opts)
        }
        TaskCommand::Show { id, json } => {
            let task = store.load(&id).map_err(code)?;
            print_task(&task, json)?;
            return Ok(Outcome::Ok);
        }
        TaskCommand::List { json } => {
            let tasks = store.list().map_err(code)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&tasks).map_err(|_| "io")?
                );
            } else {
                for task in &tasks {
                    println!("{}\t{}\t{}", task.id, task.state.as_str(), first_line(task));
                }
            }
            return Ok(Outcome::Ok);
        }
        TaskCommand::Approve { id } => store.approve_task(&id, &gate),
        TaskCommand::Discard { id } => store.discard_task(&id),
    };
    match result {
        Ok(task) => {
            match (&task.state, &task.approval) {
                (TaskState::Merged, Some(approval)) => println!("{}", approval.merge_commit),
                (TaskState::Discarded, _) => {}
                _ => print_task(&task, false)?,
            }
            Ok(Outcome::Ok)
        }
        Err(AgentError::Gated(verdict)) => {
            match verdict {
                Verdict::Ask { reason } => println!("ask\t{reason}"),
                Verdict::Deny { reason } => println!("deny\t{reason}"),
                Verdict::Allow => {}
            }
            Ok(Outcome::Exit(GATED))
        }
        Err(e) => Err(e.code()),
    }
}

/// Claude Code with the person's own config when no account is named;
/// otherwise the runner of that account's provider.
fn runner(data_dir: &Path, account: Option<&str>) -> Result<Box<dyn Runner>, &'static str> {
    let (provider, account_dir) = match account {
        Some(name) => {
            let reg = Registry::load(data_dir).map_err(|e| e.code())?;
            let entry = reg.get(name).ok_or("not_found")?;
            (entry.provider, Some(entry.dir.clone()))
        }
        None => (Provider::Claude, None),
    };
    Ok(match provider {
        Provider::Claude => Box::new(ClaudeRunner {
            account_dir,
            timeout: RUN_TIMEOUT,
        }),
        Provider::Codex => Box::new(CodexRunner {
            account_dir,
            timeout: RUN_TIMEOUT,
        }),
    })
}

fn print_task(task: &Task, json: bool) -> Result<(), &'static str> {
    if json {
        println!("{}", serde_json::to_string_pretty(task).map_err(|_| "io")?);
        return Ok(());
    }
    let dash = |v: Option<String>| v.unwrap_or_else(|| "-".to_owned());
    println!("id\t{}", task.id);
    println!("state\t{}", task.state.as_str());
    println!("goal\t{}", first_line(task));
    println!("repo\t{}", task.repo.display());
    println!("branch\t{}", task.branch);
    println!("worktree\t{}", task.worktree.display());
    println!("base\t{}", task.base);
    for run in &task.runs {
        println!(
            "run\t{}\t{}\t{}\t{}",
            run.started,
            dash(run.session_id.clone()),
            dash(run.cost_usd.map(|c| format!("{c:.4}"))),
            if run.is_error { "error" } else { "ok" }
        );
    }
    if let Some(evidence) = &task.evidence {
        println!("head\t{}", evidence.head);
        for file in &evidence.files {
            println!(
                "file\t{}\t{}\t{}",
                dash(file.added.map(|n| n.to_string())),
                dash(file.removed.map(|n| n.to_string())),
                file.path
            );
        }
        if let Some(test) = &evidence.test {
            println!(
                "test\t{}\t{}",
                dash(test.exit.map(|n| n.to_string())),
                test.command.join(" ")
            );
        }
    }
    if let Some(approval) = &task.approval {
        println!("merge\t{}", approval.merge_commit);
    }
    Ok(())
}

fn first_line(task: &Task) -> &str {
    task.goal.lines().next().unwrap_or_default()
}

fn code(e: AgentError) -> &'static str {
    e.code()
}
