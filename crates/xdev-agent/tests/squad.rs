use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::rc::Rc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tempfile::TempDir;
use xdev_agent::{
    AgentError, ContextUse, Event, QuotaCheck, Role, RunOutcome, RunRequest, Runner, RunnerFor,
    SeatStatus, Squad, SquadDeps, SquadRun, SquadStore, Step, Target, TaskState, TaskStore, Wait,
};
use xdev_ai::QuotaState;
use xdev_policy::{Action, Gate, Verdict};

/// Runs setup commands; never used for the code under test.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap()
}

const LEAD: (Role, &str) = (Role::Lead, "lead");
const DEV: (Role, &str) = (Role::Implement, "dev");
const QA: (Role, &str) = (Role::Tests, "qa");
const REV: (Role, &str) = (Role::Review, "rev");
const ALL: [(Role, &str); 4] = [LEAD, DEV, QA, REV];

struct Env {
    repo: TempDir,
    data: TempDir,
    store: SquadStore,
    fakes: Fakes,
    gate: ScriptGate,
    quota: FakeQuota,
    events: Rc<RefCell<Vec<Event>>>,
    on_event: Box<dyn Fn(&Event)>,
}

impl Env {
    fn new() -> Env {
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
        let store = SquadStore::new(data.path());
        let events = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&events);
        Env {
            repo,
            data,
            store,
            fakes: Fakes::default(),
            gate: ScriptGate::default(),
            quota: FakeQuota::default(),
            events,
            on_event: Box::new(move |e: &Event| seen.borrow_mut().push(e.clone())),
        }
    }

    fn squad(&self, seats: &[(Role, &str)]) -> Squad {
        let accounts: Vec<(Role, String)> =
            seats.iter().map(|(r, a)| (*r, (*a).to_owned())).collect();
        self.store
            .create(
                "Team",
                self.repo.path(),
                &accounts,
                Some(vec!["git".into(), "--version".into()]),
            )
            .unwrap()
    }

    fn deps(&self) -> SquadDeps<'_> {
        SquadDeps {
            runners: &self.fakes,
            gate: &self.gate,
            quota: &self.quota,
            on_event: &*self.on_event,
        }
    }

    fn run(&self, squad: &Squad) -> Result<SquadRun, AgentError> {
        self.store.run(&squad.id, "Add a greeting", &self.deps())
    }

    fn resume(&self, squad: &Squad) -> SquadRun {
        self.store.resume(&squad.id, &self.deps()).unwrap()
    }

    fn tasks(&self) -> TaskStore {
        TaskStore::new(self.data.path())
    }

    fn task_state(&self, run: &SquadRun) -> TaskState {
        self.tasks().load(&run.task).unwrap().state
    }

    /// Replies for an account, used in order before the defaults.
    fn script(&self, account: &str, replies: &[&str]) {
        self.fakes
            .script
            .replies
            .borrow_mut()
            .entry(account.to_owned())
            .or_default()
            .extend(replies.iter().map(|r| (*r).to_owned()));
    }

    /// Requests the account's agents got, in order.
    fn seen(&self, account: &str) -> Vec<RunRequest> {
        self.fakes
            .script
            .seen
            .borrow()
            .iter()
            .filter(|(a, _)| a == account)
            .map(|(_, r)| r.clone())
            .collect()
    }

    fn kinds(&self) -> Vec<String> {
        self.events
            .borrow()
            .iter()
            .map(|e| e.kind.clone())
            .collect()
    }
}

#[derive(Default)]
struct Script {
    replies: RefCell<BTreeMap<String, VecDeque<String>>>,
    seen: RefCell<Vec<(String, RunRequest)>>,
}

/// Every account gets a fake agent sharing one script.
#[derive(Default)]
struct Fakes {
    script: Rc<Script>,
}

impl RunnerFor for Fakes {
    fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError> {
        Ok(Box::new(Fake {
            account: account.to_owned(),
            script: Rc::clone(&self.script),
        }))
    }
}

/// Writes `<account>.txt` when it may write files, like an agent would.
struct Fake {
    account: String,
    script: Rc<Script>,
}

impl Runner for Fake {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
        self.script
            .seen
            .borrow_mut()
            .push((self.account.clone(), req.clone()));
        let scripted = self
            .script
            .replies
            .borrow_mut()
            .get_mut(&self.account)
            .and_then(VecDeque::pop_front);
        let result = scripted.unwrap_or_else(|| match self.account.as_str() {
            "rev" => "Looks right.\nXDEV-REVIEW: approve".to_owned(),
            "lead" => "Plan: add hello.txt".to_owned(),
            _ => "Done.".to_owned(),
        });
        if req.tools.iter().any(|t| t == "Write") {
            let file = req.worktree.join(format!("{}.txt", self.account));
            let before = fs::read_to_string(&file).unwrap_or_default();
            fs::write(&file, format!("{before}change\n")).unwrap();
        }
        Ok(RunOutcome {
            session_id: Some(format!("s-{}", self.account)),
            cost_usd: None,
            is_error: false,
            result,
            context: Some(ContextUse {
                used: 1000,
                window: 200_000,
            }),
        })
    }
}

#[derive(Default)]
struct ScriptGate {
    spawn: RefCell<Option<Verdict>>,
    seen: RefCell<Vec<Action>>,
}

impl ScriptGate {
    fn set(&self, verdict: Verdict) {
        *self.spawn.borrow_mut() = Some(verdict);
    }
}

impl Gate for ScriptGate {
    fn check(&self, action: &Action) -> Verdict {
        self.seen.borrow_mut().push(action.clone());
        match action {
            Action::SpawnAgent { .. } => self.spawn.borrow().clone().unwrap_or(Verdict::Allow),
            _ => Verdict::Allow,
        }
    }
}

#[derive(Default)]
struct FakeQuota(RefCell<BTreeMap<String, QuotaState>>);

impl FakeQuota {
    fn set(&self, account: &str, state: QuotaState) {
        self.0.borrow_mut().insert(account.to_owned(), state);
    }
}

impl QuotaCheck for FakeQuota {
    fn state(&self, account: &str) -> QuotaState {
        self.0
            .borrow()
            .get(account)
            .copied()
            .unwrap_or(QuotaState::Ok)
    }
}

fn seat(run: &SquadRun, role: Role) -> &xdev_agent::SeatState {
    &run.seats[&role]
}

#[test]
fn full_squad_plans_implements_tests_and_reviews() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    let run = env.run(&squad).unwrap();

    assert_eq!(run.status(), "done");
    assert_eq!(run.step, Step::Done);
    assert_eq!(run.round, 1);
    assert_eq!(run.plan.as_deref(), Some("Plan: add hello.txt"));
    assert_eq!(run.violations, 0);
    for role in Role::ALL {
        let s = seat(&run, role);
        assert_eq!(s.state, SeatStatus::Done, "{role:?}");
        assert_eq!(
            s.session,
            Some(format!("s-{}", squad.account(role).unwrap()))
        );
        assert_eq!(
            s.context,
            Some(ContextUse {
                used: 1000,
                window: 200_000
            })
        );
    }

    let task = env.tasks().load(&run.task).unwrap();
    assert_eq!(task.state, TaskState::Review);
    assert_eq!(task.runs.len(), 4);
    assert!(task.runs[0].summary.starts_with("[lead] "));
    let evidence = task.evidence.unwrap();
    let files: Vec<&str> = evidence.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(files, ["dev.txt", "qa.txt"]);
    assert_eq!(evidence.test.as_ref().unwrap().exit, Some(0));
    let log = git(&task.worktree, &["log", "--format=%s"]);
    assert!(log.contains("(implement): Add a greeting"), "{log}");
    assert!(log.contains("(tests): Add a greeting"), "{log}");

    // The lead and the reviewer only read; the plan and test reach later seats.
    let lead = &env.seen("lead")[0];
    assert!(!lead.tools.iter().any(|t| t == "Write"));
    assert!(env.seen("dev")[0].prompt.contains("Plan: add hello.txt"));
    let review = &env.seen("rev")[0];
    assert!(!review.tools.iter().any(|t| t == "Edit"));
    assert!(review.prompt.contains("dev.txt"));
    assert!(review.prompt.contains("`git --version` exited 0"));
    assert!(env.gate.seen.borrow().iter().any(|a| matches!(
        a,
        Action::SpawnAgent { account: Some(a), .. } if a == "dev"
    )));

    let kinds = env.kinds();
    assert_eq!(kinds.first().map(String::as_str), Some("start"));
    assert_eq!(kinds.last().map(String::as_str), Some("done"));
    assert!(kinds.iter().any(|k| k == "test"));
    assert_eq!(env.store.events(&squad.id).unwrap(), *env.events.borrow());
    assert_eq!(env.store.current_run(&squad.id).unwrap(), Some(run));
}

#[test]
fn vacant_lead_tests_and_review_are_skipped() {
    let env = Env::new();
    let squad = env.squad(&[DEV]);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "done");
    assert_eq!(run.plan, None);
    for role in [Role::Lead, Role::Tests, Role::Review] {
        assert_eq!(seat(&run, role).state, SeatStatus::Skipped, "{role:?}");
    }
    assert_eq!(seat(&run, Role::Implement).state, SeatStatus::Done);
    assert_eq!(env.seen("dev").len(), 1);
    assert_eq!(env.task_state(&run), TaskState::Review);
    assert_eq!(env.kinds().iter().filter(|k| *k == "skip").count(), 3);
}

#[test]
fn vacant_implement_seat_refuses_to_run() {
    let env = Env::new();
    let squad = env.squad(&[LEAD, QA, REV]);
    assert!(matches!(env.run(&squad), Err(AgentError::SeatVacant)));
    assert_eq!(AgentError::SeatVacant.code(), "seat_vacant");
    assert!(env.tasks().list().unwrap().is_empty());
    assert_eq!(env.store.current_run(&squad.id).unwrap(), None);
}

#[test]
fn review_asks_for_changes_twice_then_stops_after_two_rounds() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.script(
        "rev",
        &[
            "Rename the file.\nXDEV-REVIEW: changes",
            "Still wrong.\nXDEV-REVIEW: changes",
        ],
    );
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "done");
    assert_eq!(run.round, 2);
    assert_eq!(run.notes.as_deref(), Some("Still wrong."));
    assert_eq!(env.task_state(&run), TaskState::Review);

    let dev = env.seen("dev");
    assert_eq!(dev.len(), 2);
    assert!(dev[1].prompt.contains("Rename the file."));
    assert_eq!(dev[1].resume.as_deref(), Some("s-dev"));
    assert_eq!(env.seen("qa").len(), 2);
    assert_eq!(env.seen("rev").len(), 2);
    assert_eq!(env.kinds().iter().filter(|k| *k == "review").count(), 2);
}

#[test]
fn approval_in_the_second_round_ends_the_run() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.script("rev", &["Rename the file.\nXDEV-REVIEW: changes"]);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "done");
    assert_eq!(run.round, 2);
    assert_eq!(env.seen("rev").len(), 2);
}

#[test]
fn a_question_is_answered_by_the_lead() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.script(
        "dev",
        &["Looked.\nXDEV-ESCALATE: Which file name?", "Done."],
    );
    env.script("lead", &["Plan.", "Use hello.txt."]);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "done");

    let e = &run.escalations[0];
    assert_eq!(e.id, "e1");
    assert_eq!(e.from, Role::Implement);
    assert_eq!(e.to, Target::Lead);
    assert_eq!(e.step, Step::Implement);
    assert_eq!(e.question, "Which file name?");
    assert_eq!(e.answer.as_deref(), Some("Use hello.txt."));
    assert!(e.answered.is_some());

    let lead = env.seen("lead");
    assert!(lead[1].prompt.contains("Which file name?"));
    assert_eq!(lead[1].resume.as_deref(), Some("s-lead"));
    let dev = env.seen("dev");
    assert!(dev[1].prompt.contains("Use hello.txt."));
    assert!(dev[1].prompt.contains("the lead"));
    assert_eq!(dev[1].resume.as_deref(), Some("s-dev"));
}

#[test]
fn the_lead_passes_a_question_to_the_person() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.script("dev", &["XDEV-ESCALATE: May I drop the table?", "Done."]);
    env.script("lead", &["Plan.", "XDEV-ESCALATE: Only the owner can say."]);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");
    assert!(run.is_waiting());
    let dev = seat(&run, Role::Implement);
    assert_eq!(dev.state, SeatStatus::NeedsYou);
    assert_eq!(dev.wait, Some(Wait::Escalation { id: "e1".into() }));
    let e = &run.escalations[0];
    assert_eq!(e.to, Target::Person);
    assert_eq!(e.note.as_deref(), Some("Only the owner can say."));
    assert_eq!(e.answer, None);
    assert_eq!(env.task_state(&run), TaskState::Paused);

    assert!(matches!(
        env.store.answer(&squad.id, "e9", "Yes", &env.deps()),
        Err(AgentError::NotFound)
    ));
    assert!(matches!(
        env.store.answer(&squad.id, "e1", "  ", &env.deps()),
        Err(AgentError::EmptyText)
    ));
    let run = env
        .store
        .answer(&squad.id, "e1", "Yes, drop it.", &env.deps())
        .unwrap();
    assert_eq!(run.status(), "done");
    assert_eq!(run.escalations[0].answer.as_deref(), Some("Yes, drop it."));
    let dev = env.seen("dev");
    assert!(dev[1].prompt.contains("Yes, drop it."));
    assert!(dev[1].prompt.contains("the person"));
    assert!(matches!(
        env.store.answer(&squad.id, "e1", "again", &env.deps()),
        Err(AgentError::NoRun)
    ));
}

#[test]
fn with_no_lead_a_question_goes_to_the_person() {
    let env = Env::new();
    let squad = env.squad(&[DEV]);
    env.script("dev", &["XDEV-ESCALATE: Tabs or spaces?"]);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");
    assert_eq!(run.escalations[0].to, Target::Person);
    let run = env
        .store
        .answer(&squad.id, "e1", "Spaces.", &env.deps())
        .unwrap();
    assert_eq!(run.status(), "done");
}

#[test]
fn the_lead_asking_in_its_own_step_asks_the_person() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.script(
        "lead",
        &["XDEV-ESCALATE: Which database?", "Plan: use SQLite."],
    );
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");
    assert_eq!(run.escalations[0].from, Role::Lead);
    assert_eq!(run.escalations[0].to, Target::Person);
    let run = env
        .store
        .answer(&squad.id, "e1", "SQLite.", &env.deps())
        .unwrap();
    assert_eq!(run.status(), "done");
    assert_eq!(run.plan.as_deref(), Some("Plan: use SQLite."));
}

#[test]
fn gate_ask_waits_for_the_person() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.gate.set(Verdict::Ask {
        reason: "agents need approval".into(),
    });
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");
    assert_eq!(
        seat(&run, Role::Lead).wait,
        Some(Wait::Ask {
            reason: "agents need approval".into()
        })
    );
    assert_eq!(run.violations, 0);
    assert!(env.seen("lead").is_empty());
    assert_eq!(env.task_state(&run), TaskState::Paused);

    env.gate.set(Verdict::Allow);
    let run = env.resume(&squad);
    assert_eq!(run.status(), "done");
}

#[test]
fn gate_deny_is_a_violation() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.gate.set(Verdict::Deny {
        reason: "no agents".into(),
    });
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");
    assert_eq!(run.violations, 1);
    assert_eq!(
        seat(&run, Role::Lead).wait,
        Some(Wait::Deny {
            reason: "no agents".into()
        })
    );
    // Still denied: one more violation.
    let run = env.resume(&squad);
    assert_eq!(run.violations, 2);

    env.gate.set(Verdict::Allow);
    let run = env.resume(&squad);
    assert_eq!(run.status(), "done");
    assert_eq!(run.violations, 2);
}

#[test]
fn quota_in_reserve_waits_then_stop_and_resume() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.quota.set("dev", QuotaState::Reserve);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");
    assert_eq!(run.step, Step::Implement);
    assert_eq!(
        seat(&run, Role::Implement).wait,
        Some(Wait::Quota {
            state: QuotaState::Reserve
        })
    );
    assert_eq!(seat(&run, Role::Lead).state, SeatStatus::Idle);
    assert!(env.seen("dev").is_empty());

    env.store.stop(&squad.id).unwrap();
    let run = env.store.current_run(&squad.id).unwrap().unwrap();
    assert_eq!(run.status(), "stopped");
    assert_eq!(env.task_state(&run), TaskState::Paused);

    env.quota.set("dev", QuotaState::Ok);
    let run = env.resume(&squad);
    assert_eq!(run.status(), "done");
    assert_eq!(env.seen("dev").len(), 1);
}

#[test]
fn steering_reaches_a_seat_now_or_with_its_step() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.quota.set("dev", QuotaState::Full);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "waiting");

    // The lead has a session, so the words go to it at once.
    let run = env
        .store
        .steer(&squad.id, Role::Lead, "Keep it short.", &env.deps())
        .unwrap();
    let lead = env.seen("lead");
    assert_eq!(lead.len(), 2);
    assert!(lead[1].prompt.contains("Keep it short."));
    assert_eq!(lead[1].resume.as_deref(), Some("s-lead"));
    assert_eq!(run.status(), "waiting");

    // The tester has not started, so they wait for its step.
    let run = env
        .store
        .steer(&squad.id, Role::Tests, "Use table tests.", &env.deps())
        .unwrap();
    assert_eq!(seat(&run, Role::Tests).queued, ["Use table tests."]);
    assert!(env.seen("qa").is_empty());

    env.quota.set("dev", QuotaState::Ok);
    let run = env.resume(&squad);
    assert_eq!(run.status(), "done");
    assert!(env.seen("qa")[0].prompt.contains("Use table tests."));
    assert!(seat(&run, Role::Tests).queued.is_empty());
}

#[test]
fn steering_checks_the_seat_and_the_run() {
    let env = Env::new();
    let squad = env.squad(&[DEV]);
    assert!(matches!(
        env.store.steer(&squad.id, Role::Lead, "hi", &env.deps()),
        Err(AgentError::SeatVacant)
    ));
    assert!(matches!(
        env.store
            .steer(&squad.id, Role::Implement, "hi", &env.deps()),
        Err(AgentError::NoRun)
    ));
    assert!(matches!(
        env.store
            .steer(&squad.id, Role::Implement, " ", &env.deps()),
        Err(AgentError::EmptyText)
    ));
}

/// Waits for its stop signal like a long agent, then reports the session it
/// leaves.
struct Blocking(mpsc::Sender<()>);

impl RunnerFor for Blocking {
    fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError> {
        if account != "dev" {
            return Fakes::default().runner(account);
        }
        Ok(Box::new(BlockingRunner(self.0.clone())))
    }
}

struct BlockingRunner(mpsc::Sender<()>);

impl Runner for BlockingRunner {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
        self.0.send(()).unwrap();
        for _ in 0..1000 {
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
fn stop_kills_the_working_agent() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    let (started, wait) = mpsc::channel();
    let store = env.store.clone();
    let id = squad.id.clone();
    let worker = thread::spawn(move || {
        let runners = Blocking(started);
        let gate = ScriptGate::default();
        let quota = FakeQuota::default();
        let deps = SquadDeps {
            runners: &runners,
            gate: &gate,
            quota: &quota,
            on_event: &|_| {},
        };
        store.run(&id, "Add a greeting", &deps).unwrap()
    });
    wait.recv_timeout(Duration::from_secs(60)).unwrap();
    assert!(env.store.is_running(&squad.id).unwrap());
    assert!(matches!(
        env.store
            .set_seat(&squad.id, Role::Review, None)
            .map(|_| ()),
        Err(AgentError::Busy)
    ));
    env.store.stop(&squad.id).unwrap();
    let run = worker.join().unwrap();

    assert_eq!(run.status(), "stopped");
    assert_eq!(run.step, Step::Implement);
    let dev = seat(&run, Role::Implement);
    assert_eq!(dev.state, SeatStatus::Idle);
    assert_eq!(dev.session.as_deref(), Some("s-dev"));
    assert_eq!(env.task_state(&run), TaskState::Paused);
    assert!(!env.store.is_running(&squad.id).unwrap());
    assert!(
        env.store
            .events(&squad.id)
            .unwrap()
            .iter()
            .any(|e| e.kind == "stop")
    );

    // Going on resumes the killed session.
    let run = env.resume(&squad);
    assert_eq!(run.status(), "done");
    assert_eq!(env.seen("dev")[0].resume.as_deref(), Some("s-dev"));
}

#[test]
fn a_run_left_working_by_a_dead_process_comes_back_stopped() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.quota.set("dev", QuotaState::Reserve);
    let run = env.run(&squad).unwrap();

    // What a crash in the middle of the implement step leaves on disk.
    let run_file = env
        .data
        .path()
        .join("squads")
        .join(&squad.id)
        .join("runs")
        .join(format!("{}.json", run.task));
    let mut json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&run_file).unwrap()).unwrap();
    json["seats"]["implement"]["state"] = "working".into();
    json["seats"]["implement"]["wait"] = serde_json::Value::Null;
    fs::write(&run_file, json.to_string()).unwrap();
    let task_file = env
        .data
        .path()
        .join("tasks")
        .join(&run.task)
        .join("task.json");
    let text = fs::read_to_string(&task_file).unwrap();
    fs::write(&task_file, text.replace("\"paused\"", "\"running\"")).unwrap();

    let run = env.store.current_run(&squad.id).unwrap().unwrap();
    assert_eq!(run.status(), "stopped");
    assert_eq!(seat(&run, Role::Implement).state, SeatStatus::Idle);
    assert!(
        fs::read_to_string(&task_file)
            .unwrap()
            .contains("\"paused\"")
    );
    assert!(
        env.store
            .events(&squad.id)
            .unwrap()
            .iter()
            .any(|e| e.kind == "recovered")
    );
    // Loading again changes nothing more.
    assert_eq!(env.store.current_run(&squad.id).unwrap(), Some(run));

    env.quota.set("dev", QuotaState::Ok);
    assert_eq!(env.resume(&squad).status(), "done");
}

#[test]
fn a_new_run_waits_for_the_open_one() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    env.quota.set("dev", QuotaState::Reserve);
    env.run(&squad).unwrap();
    assert!(matches!(env.run(&squad), Err(AgentError::Busy)));
    // A stopped run can be left behind.
    env.store.stop(&squad.id).unwrap();
    env.quota.set("dev", QuotaState::Ok);
    let run = env.run(&squad).unwrap();
    assert_eq!(run.status(), "done");
    assert_eq!(env.tasks().list().unwrap().len(), 2);
}

#[test]
fn seats_change_and_squads_go_but_tasks_stay() {
    let env = Env::new();
    let squad = env.squad(&ALL);
    assert!(matches!("boss".parse::<Role>(), Err(AgentError::BadRole)));
    env.quota.set("dev", QuotaState::Reserve);
    let run = env.run(&squad).unwrap();

    let changed = env.store.set_seat(&squad.id, Role::Review, None).unwrap();
    assert_eq!(changed.account(Role::Review), None);
    let changed = env
        .store
        .set_seat(&squad.id, Role::Lead, Some("other"))
        .unwrap();
    assert_eq!(changed.account(Role::Lead), Some("other"));
    let open = env.store.current_run(&squad.id).unwrap().unwrap();
    assert_eq!(seat(&open, Role::Review).state, SeatStatus::Vacant);
    // A session lives in one account; the new one starts afresh.
    assert_eq!(seat(&open, Role::Lead).session, None);
    assert_eq!(env.store.load(&squad.id).unwrap(), changed);
    assert_eq!(env.store.list().unwrap(), [changed]);

    env.store.remove(&squad.id).unwrap();
    assert!(matches!(
        env.store.load(&squad.id),
        Err(AgentError::NotFound)
    ));
    assert!(env.store.list().unwrap().is_empty());
    assert!(env.tasks().load(&run.task).is_ok());
}

#[test]
fn squad_needs_a_name_and_a_repo() {
    let env = Env::new();
    assert!(matches!(
        env.store.create(" ", env.repo.path(), &[], None),
        Err(AgentError::EmptyName)
    ));
    let not_repo = TempDir::new().unwrap();
    assert!(matches!(
        env.store.create("Team", not_repo.path(), &[], None),
        Err(AgentError::NoRepo)
    ));
}
