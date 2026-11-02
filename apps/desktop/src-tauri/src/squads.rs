//! Squads for the Squads view. A run waits on one agent after another for up
//! to an hour, so run, answer, steer and resume run off the UI thread while
//! the view polls `squad_get`; `squad_stop` reaches a run in progress through
//! the store's stop file.

use std::path::Path;

use serde::Serialize;
use tauri::State;
use xdev_agent::{
    AgentError, Event, QuotaCheck, Role, Routing, Runner, RunnerFor, Seat, Squad, SquadDeps,
    SquadRun, SquadStore,
};
use xdev_ai::{QuotaState, Registry};

use crate::accounts::{data_dir, local_dir};
use crate::commands::{AppState, CmdError};
use crate::tasks::{gate, provider_runner};

/// What the squad page shows before the person asks for all activity.
const RECENT: usize = 20;

/// A squad as a person reads it: `idle` has never run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SquadStatus {
    Idle,
    Running,
    Waiting,
    Stopped,
    Done,
}

impl SquadStatus {
    fn of(run: Option<&SquadRun>) -> SquadStatus {
        match run.map(SquadRun::status) {
            None => SquadStatus::Idle,
            Some("done") => SquadStatus::Done,
            Some("stopped") => SquadStatus::Stopped,
            Some("waiting") => SquadStatus::Waiting,
            Some(_) => SquadStatus::Running,
        }
    }
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SquadItem {
    squad: Squad,
    status: SquadStatus,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SquadView {
    squad: Squad,
    run: Option<SquadRun>,
    status: SquadStatus,
    /// The latest events, oldest first.
    events: Vec<Event>,
    /// All of the squad's events, so the view knows when there are more.
    event_count: usize,
}

/// Seat agents and quotas for the person's registered accounts.
struct Registered {
    reg: Registry,
    routing: Routing,
}

impl RunnerFor for Registered {
    fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError> {
        let entry = self.reg.get(account).ok_or(AgentError::UnknownAccount)?;
        Ok(provider_runner(entry.provider, Some(entry.dir.clone())))
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

impl QuotaCheck for Registered {
    fn state(&self, account: &str) -> QuotaState {
        match self.reg.get(account) {
            Some(entry) => {
                xdev_ai::quota(entry, &xdev_ai::status(entry), self.reg.reserve_percent).state
            }
            None => QuotaState::Unknown,
        }
    }
}

fn registered(data: &Path) -> Result<Registered, CmdError> {
    Ok(Registered {
        reg: Registry::load(data)?,
        routing: Routing::load(data)?,
    })
}

fn known(data: &Path, account: &str) -> Result<(), CmdError> {
    match Registry::load(data)?.get(account) {
        Some(_) => Ok(()),
        None => Err(AgentError::UnknownAccount.into()),
    }
}

fn squads(state: &AppState) -> Result<SquadStore, CmdError> {
    Ok(SquadStore::with_local(data_dir(state)?, local_dir(state)?))
}

fn list(store: &SquadStore) -> Result<Vec<SquadItem>, CmdError> {
    let mut items = Vec::new();
    for squad in store.list()? {
        let run = store.current_run(&squad.id)?;
        items.push(SquadItem {
            status: SquadStatus::of(run.as_ref()),
            squad,
        });
    }
    Ok(items)
}

fn view(store: &SquadStore, id: &str) -> Result<SquadView, CmdError> {
    let squad = store.load(id)?;
    let run = store.current_run(id)?;
    let mut events = store.events(id)?;
    let event_count = events.len();
    events.drain(..event_count.saturating_sub(RECENT));
    Ok(SquadView {
        squad,
        status: SquadStatus::of(run.as_ref()),
        run,
        events,
        event_count,
    })
}

fn create(
    store: &SquadStore,
    name: &str,
    repo: &str,
    seats: &[Seat],
    test: Option<&str>,
) -> Result<Squad, CmdError> {
    let mut accounts = Vec::new();
    for seat in seats {
        if let Some(account) = seat.account.as_deref().map(str::trim)
            && !account.is_empty()
        {
            known(&store.data_dir, account)?;
            accounts.push((seat.role, account.to_owned()));
        }
    }
    Ok(store.create(name, Path::new(repo), &accounts, test_command(test))?)
}

fn set_seat(
    store: &SquadStore,
    id: &str,
    role: &str,
    account: Option<&str>,
) -> Result<SquadView, CmdError> {
    let role: Role = role.parse()?;
    let account = account.map(str::trim).filter(|a| !a.is_empty());
    if let Some(account) = account {
        known(&store.data_dir, account)?;
    }
    store.set_seat(id, role, account)?;
    view(store, id)
}

/// Runs `go` with the person's gate and the given agents and quotas until
/// the run is done, waits for the person, or is stopped.
fn drive(
    store: &SquadStore,
    runners: &dyn RunnerFor,
    quota: &dyn QuotaCheck,
    id: &str,
    go: impl FnOnce(&SquadStore, &SquadDeps) -> Result<SquadRun, AgentError>,
) -> Result<SquadView, CmdError> {
    let gate = gate(&store.data_dir)?;
    // The view polls the store; nothing listens for events as they happen.
    let deps = SquadDeps {
        runners,
        gate: &gate,
        quota,
        on_event: &|_| {},
    };
    go(store, &deps)?;
    view(store, id)
}

fn drive_registered(
    store: &SquadStore,
    id: &str,
    go: impl FnOnce(&SquadStore, &SquadDeps) -> Result<SquadRun, AgentError>,
) -> Result<SquadView, CmdError> {
    let accounts = registered(&store.data_dir)?;
    drive(store, &accounts, &accounts, id, go)
}

fn stop(store: &SquadStore, id: &str) -> Result<SquadView, CmdError> {
    store.stop(id)?;
    view(store, id)
}

/// Split on whitespace like the CLI's `--test`; blank means no test.
fn test_command(test: Option<&str>) -> Option<Vec<String>> {
    let parts: Vec<String> = test?.split_whitespace().map(str::to_owned).collect();
    (!parts.is_empty()).then_some(parts)
}

#[tauri::command(async)]
pub fn squads_list(state: State<'_, AppState>) -> Result<Vec<SquadItem>, CmdError> {
    list(&squads(&state)?)
}

#[tauri::command(async)]
pub fn squad_get(state: State<'_, AppState>, id: String) -> Result<SquadView, CmdError> {
    view(&squads(&state)?, &id)
}

#[tauri::command(async)]
pub fn squad_new(
    state: State<'_, AppState>,
    name: String,
    repo: String,
    seats: Vec<Seat>,
    test: Option<String>,
) -> Result<Squad, CmdError> {
    create(&squads(&state)?, &name, &repo, &seats, test.as_deref())
}

#[tauri::command(async)]
pub fn squad_set_seat(
    state: State<'_, AppState>,
    id: String,
    role: String,
    account: Option<String>,
) -> Result<SquadView, CmdError> {
    set_seat(&squads(&state)?, &id, &role, account.as_deref())
}

#[tauri::command(async)]
pub fn squad_remove(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    Ok(squads(&state)?.remove(&id)?)
}

#[tauri::command(async)]
pub fn squad_run(
    state: State<'_, AppState>,
    id: String,
    goal: String,
) -> Result<SquadView, CmdError> {
    drive_registered(&squads(&state)?, &id, |s, d| s.run(&id, &goal, d))
}

#[tauri::command(async)]
pub fn squad_answer(
    state: State<'_, AppState>,
    id: String,
    escalation: String,
    text: String,
) -> Result<SquadView, CmdError> {
    drive_registered(&squads(&state)?, &id, |s, d| {
        s.answer(&id, &escalation, &text, d)
    })
}

#[tauri::command(async)]
pub fn squad_steer(
    state: State<'_, AppState>,
    id: String,
    role: String,
    text: String,
) -> Result<SquadView, CmdError> {
    let role: Role = role.parse()?;
    drive_registered(&squads(&state)?, &id, |s, d| s.steer(&id, role, &text, d))
}

#[tauri::command(async)]
pub fn squad_resume(state: State<'_, AppState>, id: String) -> Result<SquadView, CmdError> {
    drive_registered(&squads(&state)?, &id, |s, d| s.resume(&id, d))
}

#[tauri::command(async)]
pub fn squad_stop(state: State<'_, AppState>, id: String) -> Result<SquadView, CmdError> {
    stop(&squads(&state)?, &id)
}

#[tauri::command(async)]
pub fn squad_events(state: State<'_, AppState>, id: String) -> Result<Vec<Event>, CmdError> {
    Ok(squads(&state)?.events(&id)?)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::fs;
    use std::process::Command;
    use std::sync::{Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    use tempfile::TempDir;
    use xdev_agent::{
        ContextUse, RunOutcome, RunRequest, SeatStatus, Step, Target, TaskState, TaskStore,
    };
    use xdev_ai::Provider;

    use super::*;

    /// Runs setup commands; never used for the code under test.
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A repo with one commit and a data dir with the accounts `lead`, `dev`,
    /// `qa` and `rev` registered.
    fn env() -> (TempDir, TempDir) {
        let repo = TempDir::with_prefix("squad repo ").unwrap();
        git(repo.path(), &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(repo.path(), &["config", key, value]);
        }
        fs::write(repo.path().join("README.md"), "hello\n").unwrap();
        git(repo.path(), &["add", "-A"]);
        git(repo.path(), &["commit", "-q", "-m", "init"]);

        let data = TempDir::with_prefix("xdev data ").unwrap();
        let mut reg = Registry::load(data.path()).unwrap();
        for name in ["lead", "dev", "qa", "rev"] {
            reg.add(name, Provider::Claude, data.path().join(name))
                .unwrap();
        }
        reg.save(data.path()).unwrap();
        (repo, data)
    }

    fn seats(accounts: &[(Role, &str)]) -> Vec<Seat> {
        Role::ALL
            .into_iter()
            .map(|role| Seat {
                role,
                account: accounts
                    .iter()
                    .find(|(r, _)| *r == role)
                    .map(|(_, a)| (*a).to_owned()),
            })
            .collect()
    }

    const ALL: [(Role, &str); 4] = [
        (Role::Lead, "lead"),
        (Role::Implement, "dev"),
        (Role::Tests, "qa"),
        (Role::Review, "rev"),
    ];

    /// Scripted replies per account, then a default that moves the run on.
    #[derive(Default)]
    struct Fakes {
        replies: Mutex<BTreeMap<String, VecDeque<String>>>,
    }

    impl Fakes {
        fn script(&self, account: &str, reply: &str) {
            self.replies
                .lock()
                .unwrap()
                .entry(account.to_owned())
                .or_default()
                .push_back(reply.to_owned());
        }
    }

    impl RunnerFor for Fakes {
        fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError> {
            let scripted = self
                .replies
                .lock()
                .unwrap()
                .get_mut(account)
                .and_then(VecDeque::pop_front);
            let reply = scripted.unwrap_or_else(|| match account {
                "rev" => "Looks right.\nXDEV-REVIEW: approve".to_owned(),
                "lead" => "Plan: add a file".to_owned(),
                _ => "Done.".to_owned(),
            });
            Ok(Box::new(Fake {
                account: account.to_owned(),
                reply,
            }))
        }
    }

    impl QuotaCheck for Fakes {
        fn state(&self, _account: &str) -> QuotaState {
            QuotaState::Ok
        }
    }

    /// Writes `<account>.txt` when it may write files, like an agent would.
    struct Fake {
        account: String,
        reply: String,
    }

    impl Runner for Fake {
        fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
            if req.tools.iter().any(|t| t == "Write") {
                fs::write(req.worktree.join(format!("{}.txt", self.account)), "x\n")?;
            }
            Ok(RunOutcome {
                session_id: Some(format!("s-{}", self.account)),
                cost_usd: None,
                is_error: false,
                result: self.reply.clone(),
                context: Some(ContextUse {
                    used: 150_000,
                    window: 200_000,
                }),
            })
        }
    }

    #[test]
    fn a_squad_runs_to_review_with_fake_agents() {
        let (repo, data) = env();
        let d = &SquadStore::new(data.path());
        let squad = create(
            d,
            " Feature squad ",
            &repo.path().display().to_string(),
            &seats(&ALL),
            Some("  "),
        )
        .unwrap();
        assert_eq!(squad.name, "Feature squad");
        assert_eq!(squad.test, None);
        assert_eq!(view(d, &squad.id).unwrap().status, SquadStatus::Idle);
        assert_eq!(list(d).unwrap()[0].status, SquadStatus::Idle);

        let fakes = Fakes::default();
        let shown = drive(d, &fakes, &fakes, &squad.id, |s, deps| {
            s.run(&squad.id, "Add a greeting", deps)
        })
        .unwrap();
        assert_eq!(shown.status, SquadStatus::Done);
        let run = shown.run.unwrap();
        assert_eq!(run.step, Step::Done);
        assert_eq!(run.seats[&Role::Review].state, SeatStatus::Done);
        assert_eq!(
            run.seats[&Role::Lead].context,
            Some(ContextUse {
                used: 150_000,
                window: 200_000
            })
        );
        let task = TaskStore::new(&d.data_dir).load(&run.task).unwrap();
        assert_eq!(task.state, TaskState::Review);
        assert!(shown.events.iter().any(|e| e.kind == "done"));
        assert_eq!(shown.events.len(), shown.event_count.min(RECENT));
        assert_eq!(d.events(&squad.id).unwrap().len(), shown.event_count);
        assert_eq!(list(d).unwrap()[0].status, SquadStatus::Done);
    }

    #[test]
    fn a_question_for_the_person_waits_for_their_answer() {
        let (repo, data) = env();
        let d = &SquadStore::new(data.path());
        // No lead, so the implementer's question goes straight to the person.
        let squad = create(
            d,
            "Solo",
            &repo.path().display().to_string(),
            &seats(&[(Role::Implement, "dev")]),
            None,
        )
        .unwrap();
        let fakes = Fakes::default();
        fakes.script("dev", "Looked around.\nXDEV-ESCALATE: Which file name?");
        let shown = drive(d, &fakes, &fakes, &squad.id, |s, deps| {
            s.run(&squad.id, "Add a greeting", deps)
        })
        .unwrap();
        assert_eq!(shown.status, SquadStatus::Waiting);
        let run = shown.run.unwrap();
        let e = &run.escalations[0];
        assert_eq!((e.from, e.to), (Role::Implement, Target::Person));
        assert_eq!(e.question, "Which file name?");
        assert_eq!(run.seats[&Role::Implement].state, SeatStatus::NeedsYou);

        let id = e.id.clone();
        let blank = drive(d, &fakes, &fakes, &squad.id, |s, deps| {
            s.answer(&squad.id, &id, " ", deps)
        });
        assert_eq!(blank.unwrap_err().code, "empty_text");
        let shown = drive(d, &fakes, &fakes, &squad.id, |s, deps| {
            s.answer(&squad.id, &id, "hello.txt", deps)
        })
        .unwrap();
        assert_eq!(shown.status, SquadStatus::Done);
        let run = shown.run.unwrap();
        assert_eq!(run.escalations[0].answer.as_deref(), Some("hello.txt"));
        assert_eq!(run.seats[&Role::Tests].state, SeatStatus::Skipped);
        let again = drive(d, &fakes, &fakes, &squad.id, |s, deps| {
            s.answer(&squad.id, &id, "again", deps)
        });
        assert_eq!(again.unwrap_err().code, "no_run");
    }

    /// Waits for the stop signal like a long agent does.
    struct Blocking(mpsc::Sender<()>);

    impl RunnerFor for Blocking {
        fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError> {
            if account != "dev" {
                return Fakes::default().runner(account);
            }
            Ok(Box::new(BlockingRunner(Mutex::new(self.0.clone()))))
        }
    }

    impl QuotaCheck for Blocking {
        fn state(&self, _account: &str) -> QuotaState {
            QuotaState::Unknown
        }
    }

    struct BlockingRunner(Mutex<mpsc::Sender<()>>);

    impl Runner for BlockingRunner {
        fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
            self.0.lock().unwrap().send(()).unwrap();
            for _ in 0..6000 {
                if req.cancel.is_cancelled() {
                    return Err(AgentError::Stopped {
                        session_id: Some("s-dev".into()),
                    });
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!("never stopped");
        }
    }

    #[test]
    fn stop_reaches_a_run_going_on_another_thread() {
        let (repo, data) = env();
        let d = SquadStore::new(data.path());
        let squad = create(
            &d,
            "Team",
            &repo.path().display().to_string(),
            &seats(&ALL),
            None,
        )
        .unwrap();
        let (started, wait) = mpsc::channel();
        let worker = {
            let (d, id) = (d.clone(), squad.id.clone());
            thread::spawn(move || {
                let runners = Blocking(started);
                drive(&d, &runners, &runners, &id, |s, deps| {
                    s.run(&id, "Add a greeting", deps)
                })
                .unwrap()
            })
        };
        wait.recv_timeout(Duration::from_secs(60)).unwrap();
        let during = view(&d, &squad.id).unwrap();
        assert_eq!(during.status, SquadStatus::Running);
        assert_eq!(
            during.run.as_ref().unwrap().seats[&Role::Implement].state,
            SeatStatus::Working
        );
        assert_eq!(
            set_seat(&d, &squad.id, "review", None).unwrap_err().code,
            "busy"
        );

        stop(&d, &squad.id).unwrap();
        let ended = worker.join().unwrap();
        assert_eq!(ended.status, SquadStatus::Stopped);
        let run = ended.run.unwrap();
        assert_eq!(
            run.seats[&Role::Implement].session.as_deref(),
            Some("s-dev")
        );
        let task = TaskStore::new(&d.data_dir).load(&run.task).unwrap();
        assert_eq!(task.state, TaskState::Paused);
        assert!(ended.events.iter().any(|e| e.kind == "stop"));

        let fakes = Fakes::default();
        let resumed = drive(&d, &fakes, &fakes, &squad.id, |s, deps| {
            s.resume(&squad.id, deps)
        })
        .unwrap();
        assert_eq!(resumed.status, SquadStatus::Done);
    }

    #[test]
    fn seats_and_accounts_are_checked() {
        let (repo, data) = env();
        let d = &SquadStore::new(data.path());
        let repo = repo.path().display().to_string();
        let unknown = create(d, "T", &repo, &seats(&[(Role::Implement, "ghost")]), None);
        assert_eq!(unknown.unwrap_err().code, "unknown_account");
        let blank = create(d, " ", &repo, &seats(&[(Role::Implement, "dev")]), None);
        assert_eq!(blank.unwrap_err().code, "empty_name");

        let squad = create(d, "T", &repo, &seats(&[]), Some("cargo test")).unwrap();
        assert_eq!(
            squad.test,
            Some(vec!["cargo".to_owned(), "test".to_owned()])
        );
        let fakes = Fakes::default();
        let vacant = drive(d, &fakes, &fakes, &squad.id, |s, deps| {
            s.run(&squad.id, "Go", deps)
        });
        assert_eq!(vacant.unwrap_err().code, "seat_vacant");

        assert_eq!(
            set_seat(d, &squad.id, "boss", Some("dev"))
                .unwrap_err()
                .code,
            "bad_role"
        );
        assert_eq!(
            set_seat(d, &squad.id, "implement", Some("ghost"))
                .unwrap_err()
                .code,
            "unknown_account"
        );
        let shown = set_seat(d, &squad.id, "implement", Some("dev")).unwrap();
        assert_eq!(shown.squad.account(Role::Implement), Some("dev"));
        let shown = set_seat(d, &squad.id, "implement", Some(" ")).unwrap();
        assert_eq!(shown.squad.account(Role::Implement), None);
        assert_eq!(stop(d, &squad.id).unwrap_err().code, "no_run");
        assert_eq!(view(d, "nope").unwrap_err().code, "not_found");
    }

    #[test]
    fn views_serialize_like_the_ui_expects() {
        let (repo, data) = env();
        let d = &SquadStore::new(data.path());
        let squad = create(
            d,
            "T",
            &repo.path().display().to_string(),
            &seats(&[(Role::Implement, "dev")]),
            None,
        )
        .unwrap();
        let json = serde_json::to_value(view(d, &squad.id).unwrap()).unwrap();
        assert_eq!(json["status"], "idle");
        assert_eq!(json["eventCount"], 0);
        assert_eq!(json["run"], serde_json::Value::Null);
        assert_eq!(json["squad"]["seats"][1]["role"], "implement");
        assert_eq!(json["squad"]["seats"][1]["account"], "dev");
    }
}
