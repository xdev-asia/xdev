use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde::Serialize;
use xdev_agent::{
    AgentError, Event, QuotaCheck, Role, Routing, Runner, RunnerFor, Squad, SquadDeps, SquadRun,
    SquadStore, Target,
};
use xdev_ai::{QuotaState, Registry, quota, status};
use xdev_policy::{Audited, Policy, Verdict};

use crate::Outcome;
use crate::task::{GATED, provider_runner};

#[derive(Subcommand)]
pub enum SquadCommand {
    /// Make a squad for a repo, one account per seat; prints its id. Seats
    /// left out are vacant.
    New {
        repo: PathBuf,
        name: String,
        #[arg(long)]
        implement: String,
        #[arg(long)]
        lead: Option<String>,
        #[arg(long)]
        tests: Option<String>,
        #[arg(long)]
        review: Option<String>,
        /// Test command run in the worktree after the tests step, split on
        /// whitespace.
        #[arg(long)]
        test: Option<String>,
    },
    /// Print `id<TAB>status<TAB>name<TAB>repo` per squad, newest first.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Print a squad and its current run as `key<TAB>value` lines.
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Put an account in a seat, or `none` to leave it vacant.
    Seat {
        id: String,
        role: String,
        account: String,
    },
    /// Run plan, implement, tests and review on a new task, printing each
    /// event, until done or something waits for you. Exits 3 with `ask` or
    /// `deny` and a reason when the policy stops the test command.
    Run { id: String, goal: String },
    /// Answer a question put to you, then go on.
    Answer {
        id: String,
        escalation: String,
        text: String,
    },
    /// Send a seat a message, then go on.
    Steer {
        id: String,
        role: String,
        text: String,
    },
    /// Go on with a stopped run, or retry the seats waiting on quota, the
    /// policy or a failed agent.
    Resume { id: String },
    /// Stop the run; its task is paused.
    Stop { id: String },
    /// Delete the squad; its tasks stay.
    Remove { id: String },
}

pub fn run(
    command: SquadCommand,
    data_dir: &Path,
    local_dir: &Path,
) -> Result<Outcome, &'static str> {
    let store = SquadStore::with_local(data_dir, local_dir);
    let reg = Registry::load(data_dir).map_err(|e| e.code())?;
    let known = |account: &str| -> Result<(), &'static str> {
        reg.get(account)
            .map(|_| ())
            .ok_or(AgentError::UnknownAccount.code())
    };
    let result = match command {
        SquadCommand::New {
            repo,
            name,
            implement,
            lead,
            tests,
            review,
            test,
        } => {
            let mut accounts = vec![(Role::Implement, implement)];
            for (role, account) in [
                (Role::Lead, lead),
                (Role::Tests, tests),
                (Role::Review, review),
            ] {
                if let Some(account) = account {
                    accounts.push((role, account));
                }
            }
            for (_, account) in &accounts {
                known(account)?;
            }
            let test = test.map(|t| t.split_whitespace().map(str::to_owned).collect());
            let squad = store.create(&name, &repo, &accounts, test).map_err(code)?;
            println!("{}", squad.id);
            return Ok(Outcome::Ok);
        }
        SquadCommand::List { json } => {
            let mut views = Vec::new();
            for squad in store.list().map_err(code)? {
                let run = store.current_run(&squad.id).map_err(code)?;
                views.push(View { squad, run });
            }
            if json {
                print_json(&views)?;
            } else {
                for view in &views {
                    println!(
                        "{}\t{}\t{}\t{}",
                        view.squad.id,
                        view.run.as_ref().map_or("idle", SquadRun::status),
                        view.squad.name,
                        view.squad.repo.display()
                    );
                }
            }
            return Ok(Outcome::Ok);
        }
        SquadCommand::Show { id, json } => {
            let squad = store.load(&id).map_err(code)?;
            let run = store.current_run(&id).map_err(code)?;
            let view = View { squad, run };
            if json {
                print_json(&view)?;
            } else {
                print_view(&view);
            }
            return Ok(Outcome::Ok);
        }
        SquadCommand::Seat { id, role, account } => {
            let role: Role = role.parse().map_err(code)?;
            let account = (account != "none").then_some(account);
            if let Some(account) = &account {
                known(account)?;
            }
            store
                .set_seat(&id, role, account.as_deref())
                .map_err(code)?;
            return Ok(Outcome::Ok);
        }
        SquadCommand::Stop { id } => {
            store.stop(&id).map_err(code)?;
            return Ok(Outcome::Ok);
        }
        SquadCommand::Remove { id } => {
            store.remove(&id).map_err(code)?;
            return Ok(Outcome::Ok);
        }
        SquadCommand::Run { id, goal } => drive(data_dir, &reg, |d| store.run(&id, &goal, d))?,
        SquadCommand::Answer {
            id,
            escalation,
            text,
        } => drive(data_dir, &reg, |d| store.answer(&id, &escalation, &text, d))?,
        SquadCommand::Steer { id, role, text } => {
            let role: Role = role.parse().map_err(code)?;
            drive(data_dir, &reg, |d| store.steer(&id, role, &text, d))?
        }
        SquadCommand::Resume { id } => drive(data_dir, &reg, |d| store.resume(&id, d))?,
    };
    match result {
        Ok(run) => {
            print_run(&run);
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

/// Runs `go` with the person's gate, real agents and quotas, printing
/// events as they come.
fn drive(
    data_dir: &Path,
    reg: &Registry,
    go: impl FnOnce(&SquadDeps) -> Result<SquadRun, AgentError>,
) -> Result<Result<SquadRun, AgentError>, &'static str> {
    // The person's policy file decides; every verdict lands in the audit log.
    let gate = Audited::new(Policy::load(data_dir).map_err(|e| e.code())?, data_dir);
    let routing = Routing::load(data_dir).map_err(|e| e.code())?;
    let deps = SquadDeps {
        runners: &Runners {
            reg,
            routing: &routing,
        },
        gate: &gate,
        quota: &Quotas { reg },
        on_event: &print_event,
    };
    Ok(go(&deps))
}

/// Seat agents for registered accounts.
struct Runners<'a> {
    reg: &'a Registry,
    routing: &'a Routing,
}

impl RunnerFor for Runners<'_> {
    fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError> {
        let entry = self.reg.get(account).ok_or(AgentError::UnknownAccount)?;
        provider_runner(entry.provider, Some(entry.dir.clone()))
    }

    fn provider(&self, account: &str) -> String {
        self.reg
            .get(account)
            .and_then(|e| serde_json::to_value(e.provider).ok())
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    fn model(&self, account: &str, role: Role, prompt: &str) -> Option<String> {
        self.routing
            .pick(role.as_str(), &self.provider(account), prompt)
    }
}

struct Quotas<'a> {
    reg: &'a Registry,
}

impl QuotaCheck for Quotas<'_> {
    fn state(&self, account: &str) -> QuotaState {
        match self.reg.get(account) {
            Some(entry) => quota(entry, &status(entry), self.reg.reserve_percent).state,
            None => QuotaState::Unknown,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    squad: Squad,
    run: Option<SquadRun>,
}

fn print_event(event: &Event) {
    println!(
        "{}\t{}\t{}",
        event.kind,
        event.role.map_or("-", Role::as_str),
        one_line(&event.text)
    );
}

fn print_view(view: &View) {
    let squad = &view.squad;
    println!("id\t{}", squad.id);
    println!("name\t{}", squad.name);
    println!("repo\t{}", squad.repo.display());
    if let Some(test) = &squad.test {
        println!("test\t{}", test.join(" "));
    }
    for seat in &squad.seats {
        let state = view
            .run
            .as_ref()
            .and_then(|r| r.seats.get(&seat.role))
            .map_or("idle", |s| s.state.as_str());
        println!(
            "seat\t{}\t{}\t{state}",
            seat.role.as_str(),
            seat.account.as_deref().unwrap_or("-")
        );
    }
    if let Some(run) = &view.run {
        print_run(run);
    }
}

fn print_run(run: &SquadRun) {
    println!("task\t{}", run.task);
    println!("step\t{}", run.step.as_str());
    println!("round\t{}", run.round);
    println!("status\t{}", run.status());
    println!("violations\t{}", run.violations);
    for (role, seat) in &run.seats {
        if let Some(wait) = &seat.wait {
            println!("waiting\t{}\t{}", role.as_str(), one_line(&wait.text()));
        }
    }
    for e in &run.escalations {
        let to = match e.to {
            Target::Lead => "lead",
            Target::Person => "person",
        };
        let state = if e.answered.is_some() {
            "answered"
        } else {
            "open"
        };
        println!(
            "escalation\t{}\t{}\t{to}\t{state}\t{}",
            e.id,
            e.from.as_str(),
            one_line(&e.question)
        );
    }
    if let Some(notes) = &run.notes {
        println!("notes\t{}", one_line(notes));
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<(), &'static str> {
    println!("{}", serde_json::to_string_pretty(value).map_err(|_| "io")?);
    Ok(())
}

/// Keeps one record per line for scripts.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn code(e: AgentError) -> &'static str {
    e.code()
}
