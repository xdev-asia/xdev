//! A squad run: plan, implement, tests and review, each by its own seat,
//! with questions passed up to the lead and then the person.

use std::fs;

use xdev_ai::QuotaState;
use xdev_policy::{Action, Gate, Verdict};

use crate::flow::{allow, commit, evidence, fill_run, killed_session, run_test};
use crate::prompts::{self, Verdict as Review};
use crate::squad::{
    Escalation, Event, RunLock, STOP, SeatStatus, Squad, SquadRun, SquadStore, Step, Target, Turn,
    TurnKind, Wait, clip,
};
use crate::store::LiveGuard;
use crate::{
    AgentError, Cancel, DEFAULT_TOOLS, Role, RunRecord, RunRequest, Runner, Task, TaskState,
    TaskStore, now, tail,
};

/// Review rounds before the run ends with the notes left for the person.
const MAX_ROUNDS: u8 = 2;
/// Questions a seat may put to the lead in one step before the person is
/// asked instead, so two agents cannot talk in circles.
const LEAD_ASKS: usize = 3;
const READ_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
const PLAN_MAX: usize = 8000;
const ANSWER_MAX: usize = 4000;

/// Gives each seat the runner for its account; tests hand out fakes.
pub trait RunnerFor {
    fn runner(&self, account: &str) -> Result<Box<dyn Runner>, AgentError>;

    /// The provider the gate sees for the account.
    fn provider(&self, _account: &str) -> String {
        "claude".to_owned()
    }
}

/// Checked before every agent a seat starts.
pub trait QuotaCheck {
    fn state(&self, account: &str) -> QuotaState;
}

pub struct SquadDeps<'a> {
    pub runners: &'a dyn RunnerFor,
    pub gate: &'a dyn Gate,
    pub quota: &'a dyn QuotaCheck,
    /// Sees every event as it is written, for a live view.
    pub on_event: &'a dyn Fn(&Event),
}

impl SquadStore {
    /// Starts a run on a new task and drives it until it is done, waits for
    /// the person, or is stopped.
    pub fn run(&self, id: &str, goal: &str, deps: &SquadDeps) -> Result<SquadRun, AgentError> {
        if goal.trim().is_empty() {
            return Err(AgentError::EmptyGoal);
        }
        let squad = self.load(id)?;
        if squad.account(Role::Implement).is_none() {
            return Err(AgentError::SeatVacant);
        }
        let lock = self.lock(id)?.ok_or(AgentError::Busy)?;
        if self.open_run(id)?.is_some_and(|r| !r.stopped) {
            return Err(AgentError::Busy);
        }
        // Checked before anything starts, like a task's test.
        if let Some(cmd) = squad.test_command() {
            allow(deps.gate.check(&Action::RunCommand {
                program: cmd[0].clone(),
                args: cmd[1..].to_vec(),
                cwd: squad.repo.clone(),
            }))?;
        }
        let task = self.tasks().new_task(&squad.repo, goal)?;
        let run = SquadRun::new(&squad, task.id.clone(), task.goal.clone());
        self.save_run(&run)?;
        let driver = Driver::new(self, squad, run, task, deps);
        driver.event("start", None, &driver.run.goal.clone())?;
        driver.event("step", Some(Role::Lead), Step::Plan.as_str())?;
        driver.drive(lock)
    }

    /// Answers a question put to the person, then goes on.
    pub fn answer(
        &self,
        id: &str,
        escalation: &str,
        text: &str,
        deps: &SquadDeps,
    ) -> Result<SquadRun, AgentError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(AgentError::EmptyText);
        }
        let (squad, lock, mut run, task) = self.open(id)?;
        let e = run
            .escalations
            .iter_mut()
            .find(|e| e.id == escalation)
            .ok_or(AgentError::NotFound)?;
        if e.to != Target::Person || e.answered.is_some() {
            return Err(AgentError::NotWaiting);
        }
        e.answer = Some(text.to_owned());
        e.answered = Some(now());
        let from = e.from;
        let seat = run.seat_mut(from);
        if seat.wait
            == Some(Wait::Escalation {
                id: escalation.to_owned(),
            })
        {
            seat.state = SeatStatus::Idle;
            seat.wait = None;
        }
        run.stopped = false;
        let driver = Driver::new(self, squad, run, task, deps);
        driver.event("answer", Some(from), text)?;
        driver.drive(lock)
    }

    /// Sends the person's words to a seat. A seat with a session gets them
    /// at once, or after its agent ends when one is working; a seat that has
    /// not started gets them with its step.
    pub fn steer(
        &self,
        id: &str,
        role: Role,
        text: &str,
        deps: &SquadDeps,
    ) -> Result<SquadRun, AgentError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(AgentError::EmptyText);
        }
        let squad = self.load(id)?;
        if squad.account(role).is_none() {
            return Err(AgentError::SeatVacant);
        }
        let mut run = self.open_run(id)?.ok_or(AgentError::NoRun)?;
        let Some(lock) = self.lock(id)? else {
            // The process driving the run picks it up between agents.
            self.push_inbox(id, role, text)?;
            let event = Event::new("steer", Some(role), text);
            self.append_event(id, &event)?;
            (deps.on_event)(&event);
            return Ok(run);
        };
        run.seat_mut(role).queued.push(text.to_owned());
        run.stopped = false;
        let task = self.tasks().load(&run.task)?;
        let driver = Driver::new(self, squad, run, task, deps);
        driver.event("steer", Some(role), text)?;
        driver.drive(lock)
    }

    /// Goes on with a stopped run, or retries the seats waiting on quota,
    /// the gate or a failed agent. Questions still wait for an answer.
    pub fn resume(&self, id: &str, deps: &SquadDeps) -> Result<SquadRun, AgentError> {
        let (squad, lock, mut run, task) = self.open(id)?;
        for seat in run.seats.values_mut() {
            if seat.state == SeatStatus::NeedsYou
                && !matches!(seat.wait, Some(Wait::Escalation { .. }))
            {
                seat.state = SeatStatus::Idle;
                seat.wait = None;
            }
        }
        run.stopped = false;
        let driver = Driver::new(self, squad, run, task, deps);
        driver.event("resume", None, "")?;
        driver.drive(lock)
    }

    /// Stops the run: kills a working agent and pauses the task. The process
    /// driving the run, this one or another, sees the request within a
    /// second.
    pub fn stop(&self, id: &str) -> Result<(), AgentError> {
        self.load(id)?;
        let Some(_lock) = self.lock(id)? else {
            fs::write(self.dir(id).join(STOP), "")?;
            return Ok(());
        };
        let mut run = self.open_run(id)?.ok_or(AgentError::NoRun)?;
        if run.stopped {
            return Ok(());
        }
        run.halt();
        self.save_run(&run)?;
        self.append_event(id, &Event::new("stop", None, "stopped by the person"))?;
        pause(&self.tasks(), &run.task)?;
        Ok(())
    }

    fn open(&self, id: &str) -> Result<(Squad, RunLock, SquadRun, Task), AgentError> {
        let squad = self.load(id)?;
        let lock = self.lock(id)?.ok_or(AgentError::Busy)?;
        let run = self.open_run(id)?.ok_or(AgentError::NoRun)?;
        let task = self.tasks().load(&run.task)?;
        Ok((squad, lock, run, task))
    }
}

fn pause(tasks: &TaskStore, id: &str) -> Result<(), AgentError> {
    let mut task = tasks.load(id)?;
    if matches!(task.state, TaskState::Running | TaskState::Paused) {
        task.state = TaskState::Paused;
        tasks.save(&task)?;
    }
    Ok(())
}

struct Driver<'a> {
    store: &'a SquadStore,
    tasks: TaskStore,
    deps: &'a SquadDeps<'a>,
    squad: Squad,
    run: SquadRun,
    task: Task,
    cancel: Cancel,
}

impl<'a> Driver<'a> {
    fn new(
        store: &'a SquadStore,
        squad: Squad,
        run: SquadRun,
        task: Task,
        deps: &'a SquadDeps<'a>,
    ) -> Driver<'a> {
        Driver {
            store,
            tasks: store.tasks(),
            deps,
            cancel: Cancel::with_file(store.dir(&squad.id).join(STOP)),
            squad,
            run,
            task,
        }
    }

    fn drive(mut self, lock: RunLock) -> Result<SquadRun, AgentError> {
        let _lock = lock;
        let _live = LiveGuard::take(&self.task.id).ok_or(AgentError::Busy)?;
        let stop = self.store.dir(&self.squad.id).join(STOP);
        self.task.state = TaskState::Running;
        let result = self.save().and_then(|()| self.go());
        if let Err(e) = &result {
            self.run.halt();
            let _ = self.event("error", None, &e.to_string());
        }
        if self.run.ended.is_none() && self.task.state == TaskState::Running {
            self.task.state = TaskState::Paused;
        }
        let saved = self.save();
        let _ = fs::remove_file(&stop);
        result.and(saved).map(|()| self.run)
    }

    fn go(&mut self) -> Result<(), AgentError> {
        loop {
            for (role, text) in self.store.drain_inbox(&self.squad.id)? {
                self.run.seat_mut(role).queued.push(text);
            }
            if self.cancel.is_cancelled() {
                self.run.halt();
                self.event("stop", None, "stopped by the person")?;
                return Ok(());
            }
            self.send_steers();
            let Some(turn) = self.run.turns.last().cloned() else {
                return Ok(());
            };
            if !self.take(turn)? {
                return Ok(());
            }
        }
    }

    /// Queued words go to every seat that has a session to resume.
    fn send_steers(&mut self) {
        for role in Role::ALL {
            let seat = self.run.seat_mut(role);
            if seat.queued.is_empty() || seat.session.is_none() {
                continue;
            }
            let text = seat.queued.join("\n\n");
            seat.queued.clear();
            self.run.turns.push(Turn {
                role,
                kind: TurnKind::Send {
                    text: prompts::steer(&text),
                },
                main: false,
            });
        }
    }

    /// Sends one turn. `false` when the run cannot go on by itself.
    fn take(&mut self, turn: Turn) -> Result<bool, AgentError> {
        let role = turn.role;
        if let TurnKind::Answer { escalation } = &turn.kind
            && self.escalation(escalation).answered.is_none()
        {
            let wait = Wait::Escalation {
                id: escalation.clone(),
            };
            self.wait(role, wait)?;
            return Ok(false);
        }
        let steer = matches!(turn.kind, TurnKind::Send { .. }) && !turn.main;
        if !steer && self.run.seat_mut(role).state == SeatStatus::NeedsYou {
            return Ok(false);
        }
        let Some(account) = self.squad.account(role).map(str::to_owned) else {
            return self.vacant(turn);
        };

        let quota = self.deps.quota.state(&account);
        if matches!(quota, QuotaState::Reserve | QuotaState::Full) {
            self.wait(role, Wait::Quota { state: quota })?;
            return Ok(false);
        }
        let read_only = role.reads_only() || matches!(turn.kind, TurnKind::Ask { .. });
        let tools: Vec<String> = if read_only {
            READ_TOOLS.iter().map(|t| (*t).to_owned()).collect()
        } else {
            DEFAULT_TOOLS.iter().map(|t| (*t).to_owned()).collect()
        };
        let verdict = self.deps.gate.check(&Action::SpawnAgent {
            provider: self.deps.runners.provider(&account),
            account: Some(account.clone()),
            worktree: self.task.worktree.clone(),
            tools: tools.clone(),
        });
        match verdict {
            Verdict::Allow => {}
            Verdict::Ask { reason } => {
                self.wait(role, Wait::Ask { reason })?;
                return Ok(false);
            }
            Verdict::Deny { reason } => {
                self.run.violations += 1;
                self.wait(role, Wait::Deny { reason })?;
                return Ok(false);
            }
        }
        let runner = match self.deps.runners.runner(&account) {
            Ok(runner) => runner,
            Err(e) => {
                let code = e.code().to_owned();
                self.wait(role, Wait::Error { code })?;
                return Ok(false);
            }
        };

        let prompt = self.prompt(&turn)?;
        let seat = self.run.seat_mut(role);
        seat.state = SeatStatus::Working;
        seat.wait = None;
        let resume = seat.session.clone();
        self.task.runs.push(RunRecord {
            started: now(),
            ended: None,
            session_id: resume.clone(),
            cost_usd: None,
            is_error: false,
            summary: String::new(),
        });
        self.save()?;
        self.event("turn", Some(role), turn_text(&turn.kind))?;

        let result = runner.run(&RunRequest {
            worktree: self.task.worktree.clone(),
            prompt,
            resume,
            tools,
            cancel: self.cancel.clone(),
        });
        let record = self.task.runs.last_mut().expect("a run was pushed");
        fill_run(record, &result);
        record.summary = format!("[{}] {}", role.as_str(), record.summary);
        let seat = self.run.seat_mut(role);
        seat.state = SeatStatus::Idle;
        let out = match result {
            Ok(out) => out,
            Err(e) => {
                if let Some(id) = killed_session(&e) {
                    seat.session = Some(id.to_owned());
                }
                if matches!(e, AgentError::Stopped { .. }) {
                    self.run.halt();
                    self.event("stop", Some(role), "stopped by the person")?;
                    return Ok(false);
                }
                self.event("error", Some(role), &e.to_string())?;
                let code = e.code().to_owned();
                self.wait(role, Wait::Error { code })?;
                return Ok(false);
            }
        };
        if out.session_id.is_some() {
            seat.session.clone_from(&out.session_id);
        }
        if out.context.is_some() {
            seat.context = out.context;
        }
        seat.last = clip(&out.result);
        self.event("reply", Some(role), &out.result)?;
        if out.is_error {
            self.wait(
                role,
                Wait::Error {
                    code: "runner".to_owned(),
                },
            )?;
            return Ok(false);
        }
        let go_on = self.after(turn, &out.result)?;
        self.save()?;
        Ok(go_on)
    }

    /// What a seat's reply leads to: a question, an answer, the next step.
    fn after(&mut self, turn: Turn, text: &str) -> Result<bool, AgentError> {
        let role = turn.role;
        if let Some(question) = prompts::escalation(text) {
            if let TurnKind::Ask { escalation } = &turn.kind {
                let e = self.escalation_mut(escalation);
                e.to = Target::Person;
                e.note = Some(question.clone());
                let from = e.from;
                self.run.turns.pop();
                self.event(
                    "escalation",
                    Some(Role::Lead),
                    &format!("for the person, from {}: {question}", from.as_str()),
                )?;
                return Ok(true);
            }
            let step = self.run.step;
            let asked = self
                .run
                .escalations
                .iter()
                .filter(|e| e.from == role && e.step == step)
                .count();
            let to = if role != Role::Lead
                && self.squad.account(Role::Lead).is_some()
                && asked < LEAD_ASKS
            {
                Target::Lead
            } else {
                Target::Person
            };
            let id = format!("e{}", self.run.escalations.len() + 1);
            self.run.escalations.push(Escalation {
                id: id.clone(),
                from: role,
                to,
                step,
                question: question.clone(),
                note: None,
                answer: None,
                at: now(),
                answered: None,
            });
            self.run.turns.pop();
            self.run.turns.push(Turn {
                role,
                kind: TurnKind::Answer {
                    escalation: id.clone(),
                },
                main: turn.main,
            });
            if to == Target::Lead {
                self.run.turns.push(Turn {
                    role: Role::Lead,
                    kind: TurnKind::Ask { escalation: id },
                    main: false,
                });
            }
            let target = match to {
                Target::Lead => "lead",
                Target::Person => "person",
            };
            self.event(
                "escalation",
                Some(role),
                &format!("for the {target}: {question}"),
            )?;
            return Ok(true);
        }
        self.run.turns.pop();
        match &turn.kind {
            TurnKind::Ask { escalation } => {
                let e = self.escalation_mut(escalation);
                e.answer = Some(tail(text.trim(), ANSWER_MAX));
                e.answered = Some(now());
                Ok(true)
            }
            _ if turn.main => self.advance(Some(text)),
            _ => Ok(true),
        }
    }

    /// A seat with no account: the lead's questions go to the person, other
    /// steps are passed over. Nothing can be done without an implementer.
    fn vacant(&mut self, turn: Turn) -> Result<bool, AgentError> {
        let role = turn.role;
        if role == Role::Implement {
            self.wait(
                role,
                Wait::Error {
                    code: AgentError::SeatVacant.code().to_owned(),
                },
            )?;
            return Ok(false);
        }
        self.run.turns.pop();
        if let TurnKind::Ask { escalation } = &turn.kind {
            let e = self.escalation_mut(escalation);
            e.to = Target::Person;
            let from = e.from;
            self.event(
                "escalation",
                Some(from),
                "for the person: the lead seat is vacant",
            )?;
            return Ok(true);
        }
        if !turn.main {
            return Ok(true);
        }
        self.run.seat_mut(role).state = SeatStatus::Skipped;
        self.event("skip", Some(role), "vacant")?;
        self.advance(None)
    }

    /// Moves past the finished step. `text` is the step's last reply, `None`
    /// for a step passed over.
    fn advance(&mut self, text: Option<&str>) -> Result<bool, AgentError> {
        match self.run.step {
            Step::Plan => {
                self.run.plan = text
                    .map(|t| tail(t.trim(), PLAN_MAX))
                    .filter(|t| !t.is_empty());
                self.enter(Step::Implement)
            }
            Step::Implement => {
                commit(&self.task, Some(Role::Implement.as_str()))?;
                self.enter(Step::Tests)
            }
            Step::Tests => {
                commit(&self.task, Some(Role::Tests.as_str()))?;
                if let Some(cmd) = self.squad.test_command() {
                    let test = run_test(&cmd, &self.task.worktree, &self.cancel);
                    let exit = test
                        .exit
                        .map_or_else(|| "killed".to_owned(), |c| format!("exit {c}"));
                    self.event("test", None, &format!("{}: {exit}", cmd.join(" ")))?;
                    self.run.test = Some(test);
                }
                self.enter(Step::Review)
            }
            Step::Review => {
                let Some(text) = text else {
                    return self.finish();
                };
                let (verdict, notes) = prompts::review_verdict(text);
                if verdict == Review::Approve {
                    self.event("review", Some(Role::Review), "approve")?;
                    return self.finish();
                }
                self.run.notes = Some(notes.clone()).filter(|n| !n.is_empty());
                self.event("review", Some(Role::Review), "changes")?;
                if self.run.round >= MAX_ROUNDS {
                    return self.finish();
                }
                self.run.round += 1;
                self.run.step = Step::Implement;
                self.event("step", Some(Role::Implement), Step::Implement.as_str())?;
                self.run.turns.push(Turn {
                    role: Role::Implement,
                    kind: TurnKind::Send {
                        text: prompts::changes(&notes),
                    },
                    main: true,
                });
                Ok(true)
            }
            Step::Done => Ok(false),
        }
    }

    fn enter(&mut self, step: Step) -> Result<bool, AgentError> {
        self.run.step = step;
        let role = step.role().expect("a working step");
        self.event("step", Some(role), step.as_str())?;
        self.run.turns.push(Turn {
            role,
            kind: TurnKind::Step,
            main: true,
        });
        Ok(true)
    }

    /// Commits what is left and hands the task to the person for review.
    fn finish(&mut self) -> Result<bool, AgentError> {
        commit(&self.task, None)?;
        self.task.evidence = Some(evidence(&self.task, self.run.test.clone())?);
        self.task.state = TaskState::Review;
        self.run.step = Step::Done;
        self.run.ended = Some(now());
        self.run.turns.clear();
        for seat in self.run.seats.values_mut() {
            if matches!(seat.state, SeatStatus::Idle | SeatStatus::NeedsYou) {
                seat.state = SeatStatus::Done;
                seat.wait = None;
            }
        }
        let text = match &self.run.notes {
            Some(notes) if self.run.round >= MAX_ROUNDS => {
                format!("for review, with notes: {notes}")
            }
            _ => "for review".to_owned(),
        };
        self.event("done", None, &text)?;
        Ok(false)
    }

    fn prompt(&mut self, turn: &Turn) -> Result<String, AgentError> {
        let role = turn.role;
        let fresh = self.run.seat_mut(role).session.is_none();
        let text = match &turn.kind {
            TurnKind::Step => {
                let mut prompt = self.step_prompt(role)?;
                let seat = self.run.seat_mut(role);
                if !seat.queued.is_empty() {
                    prompt.push_str("\n\n");
                    prompt.push_str(&prompts::steer(&seat.queued.join("\n\n")));
                    seat.queued.clear();
                }
                return Ok(prompt);
            }
            TurnKind::Ask { escalation } => {
                let e = self.escalation(escalation);
                return Ok(prompts::lead_question(&self.run.goal, e.from, &e.question));
            }
            TurnKind::Send { text } => text.clone(),
            TurnKind::Answer { escalation } => {
                let e = self.escalation(escalation);
                prompts::answer(
                    &e.question,
                    e.answer.as_deref().unwrap_or_default(),
                    e.to == Target::Person,
                )
            }
        };
        // A seat with no session to resume needs its step's context too.
        if fresh {
            Ok(format!("{}\n\n{text}", self.step_prompt(role)?))
        } else {
            Ok(text)
        }
    }

    fn step_prompt(&self, role: Role) -> Result<String, AgentError> {
        let goal = &self.run.goal;
        let plan = self.run.plan.as_deref();
        Ok(match role {
            Role::Lead => prompts::plan(goal),
            Role::Implement => prompts::implement(goal, plan),
            Role::Tests => {
                let files = evidence(&self.task, None)?.files;
                prompts::tests(goal, plan, &files, self.run.round)
            }
            Role::Review => {
                let files = evidence(&self.task, None)?.files;
                prompts::review(goal, plan, &files, self.run.test.as_ref(), self.run.round)
            }
        })
    }

    fn wait(&mut self, role: Role, wait: Wait) -> Result<(), AgentError> {
        let text = wait.text();
        let seat = self.run.seat_mut(role);
        seat.state = SeatStatus::NeedsYou;
        seat.wait = Some(wait);
        self.event("needs_you", Some(role), &text)?;
        self.save()
    }

    fn escalation(&self, id: &str) -> &Escalation {
        self.run
            .escalations
            .iter()
            .find(|e| e.id == id)
            .expect("turns name escalations of their run")
    }

    fn escalation_mut(&mut self, id: &str) -> &mut Escalation {
        self.run
            .escalations
            .iter_mut()
            .find(|e| e.id == id)
            .expect("turns name escalations of their run")
    }

    fn event(&self, kind: &str, role: Option<Role>, text: &str) -> Result<(), AgentError> {
        let event = Event::new(kind, role, text);
        self.store.append_event(&self.squad.id, &event)?;
        (self.deps.on_event)(&event);
        Ok(())
    }

    fn save(&self) -> Result<(), AgentError> {
        self.store.save_run(&self.run)?;
        self.tasks.save(&self.task)
    }
}

fn turn_text(kind: &TurnKind) -> &'static str {
    match kind {
        TurnKind::Step => "step",
        TurnKind::Send { .. } => "message",
        TurnKind::Ask { .. } => "question from a seat",
        TurnKind::Answer { .. } => "answer",
    }
}
