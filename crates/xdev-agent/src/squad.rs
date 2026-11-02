use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use xdev_ai::QuotaState;

use crate::flow::open_repo;
use crate::id::{new_id, valid_id};
use crate::store::write_atomic;
use crate::{AgentError, ContextUse, TaskState, TaskStore, TestResult, now, tail};

const SQUAD_FILE: &str = "squad.json";
const EVENTS: &str = "events.jsonl";
const LOCK: &str = "run.lock";
const LOCK_TRIES: u32 = 10;
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(20);
/// Its presence asks the process driving the run to stop.
pub(crate) const STOP: &str = "stop";
/// Steers sent while another process drives the run.
const INBOX: &str = "inbox.jsonl";
/// Longest text kept in an event or a seat's `last`.
pub(crate) const TEXT_MAX: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Lead,
    Implement,
    Tests,
    Review,
}

impl Role {
    pub const ALL: [Role; 4] = [Role::Lead, Role::Implement, Role::Tests, Role::Review];

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Lead => "lead",
            Role::Implement => "implement",
            Role::Tests => "tests",
            Role::Review => "review",
        }
    }

    /// Lead and review judge the work; they never change it.
    pub(crate) fn reads_only(self) -> bool {
        matches!(self, Role::Lead | Role::Review)
    }
}

impl FromStr for Role {
    type Err = AgentError;

    fn from_str(s: &str) -> Result<Role, AgentError> {
        Role::ALL
            .into_iter()
            .find(|r| r.as_str() == s)
            .ok_or(AgentError::BadRole)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    pub role: Role,
    /// `None` is a vacant seat.
    pub account: Option<String>,
}

/// A team of agents for one repo, kept in
/// `<data_dir>/squads/<id>/squad.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Squad {
    pub id: String,
    pub name: String,
    /// The repo's top folder.
    pub repo: PathBuf,
    /// One per role, in [`Role::ALL`] order.
    pub seats: [Seat; 4],
    /// Run in the worktree after the tests step: program, then arguments.
    pub test: Option<Vec<String>>,
    /// Unix seconds.
    pub created: u64,
}

impl Squad {
    pub fn account(&self, role: Role) -> Option<&str> {
        self.seats
            .iter()
            .find(|s| s.role == role)
            .and_then(|s| s.account.as_deref())
    }

    pub(crate) fn test_command(&self) -> Option<Vec<String>> {
        self.test.clone().filter(|cmd| !cmd.is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Plan,
    Implement,
    Tests,
    Review,
    Done,
}

impl Step {
    pub fn as_str(self) -> &'static str {
        match self {
            Step::Plan => "plan",
            Step::Implement => "implement",
            Step::Tests => "tests",
            Step::Review => "review",
            Step::Done => "done",
        }
    }

    pub fn role(self) -> Option<Role> {
        match self {
            Step::Plan => Some(Role::Lead),
            Step::Implement => Some(Role::Implement),
            Step::Tests => Some(Role::Tests),
            Step::Review => Some(Role::Review),
            Step::Done => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SeatStatus {
    Idle,
    Working,
    NeedsYou,
    Done,
    Vacant,
    /// Vacant when its step came, so the step was passed over.
    Skipped,
}

impl SeatStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SeatStatus::Idle => "idle",
            SeatStatus::Working => "working",
            SeatStatus::NeedsYou => "needs_you",
            SeatStatus::Done => "done",
            SeatStatus::Vacant => "vacant",
            SeatStatus::Skipped => "skipped",
        }
    }
}

/// Why a seat needs the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Wait {
    /// The account is into the person's reserve, or full.
    Quota { state: QuotaState },
    /// The gate wants the person to approve the agent.
    Ask { reason: String },
    /// The gate refused the agent; counted as a violation.
    Deny { reason: String },
    /// A question only the person can answer.
    Escalation { id: String },
    /// The agent failed; `code` is an [`AgentError::code`].
    Error { code: String },
}

impl Wait {
    pub fn text(&self) -> String {
        match self {
            Wait::Quota { state } => format!(
                "quota {}",
                serde_json::to_value(state)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default()
            ),
            Wait::Ask { reason } => format!("ask {reason}"),
            Wait::Deny { reason } => format!("deny {reason}"),
            Wait::Escalation { id } => format!("escalation {id}"),
            Wait::Error { code } => format!("error {code}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SeatState {
    pub state: SeatStatus,
    /// The agent session the seat's next turn resumes.
    pub session: Option<String>,
    pub context: Option<ContextUse>,
    /// The end of the seat's last reply.
    pub last: String,
    pub wait: Option<Wait>,
    /// Messages from the person not sent yet: a seat with no session gets
    /// them with its step.
    #[serde(default)]
    pub queued: Vec<String>,
}

impl SeatState {
    fn new(state: SeatStatus) -> SeatState {
        SeatState {
            state,
            session: None,
            context: None,
            last: String::new(),
            wait: None,
            queued: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
// The export module already has a `Target` in the bindings.
#[cfg_attr(feature = "ts", ts(rename = "EscalationTarget"))]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Lead,
    Person,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Escalation {
    /// `e1`, `e2`... within the run.
    pub id: String,
    pub from: Role,
    pub to: Target,
    pub step: Step,
    pub question: String,
    /// What the lead asked when it passed the question on to the person.
    pub note: Option<String>,
    pub answer: Option<String>,
    pub at: u64,
    pub answered: Option<u64>,
}

/// One message to one seat. The run keeps a stack of them; the top one is
/// sent next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Turn {
    pub(crate) role: Role,
    pub(crate) kind: TurnKind,
    /// Finishing it finishes the step.
    pub(crate) main: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum TurnKind {
    /// The step's own prompt.
    Step,
    Send {
        text: String,
    },
    /// The lead answers a seat's question.
    Ask {
        escalation: String,
    },
    /// The asker gets the answer and goes on.
    Answer {
        escalation: String,
    },
}

/// One goal worked by a squad, kept in
/// `<data_dir>/squads/<id>/runs/<task id>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SquadRun {
    pub squad: String,
    /// The task the run works in; also the run's file name.
    pub task: String,
    pub goal: String,
    pub step: Step,
    /// Review round, 1 or 2.
    pub round: u8,
    pub seats: BTreeMap<Role, SeatState>,
    pub escalations: Vec<Escalation>,
    pub plan: Option<String>,
    /// The reviewer's last notes.
    pub notes: Option<String>,
    pub test: Option<TestResult>,
    /// Agents the gate denied in this run.
    pub violations: u32,
    /// Stopped by the person, or found dead; it goes on only when asked.
    pub stopped: bool,
    #[cfg_attr(feature = "ts", ts(skip))]
    pub(crate) turns: Vec<Turn>,
    pub started: u64,
    pub ended: Option<u64>,
}

impl SquadRun {
    pub(crate) fn new(squad: &Squad, task: String, goal: String) -> SquadRun {
        let seats = Role::ALL
            .into_iter()
            .map(|role| {
                let state = if squad.account(role).is_some() {
                    SeatStatus::Idle
                } else {
                    SeatStatus::Vacant
                };
                (role, SeatState::new(state))
            })
            .collect();
        SquadRun {
            squad: squad.id.clone(),
            task,
            goal,
            step: Step::Plan,
            round: 1,
            seats,
            escalations: Vec::new(),
            plan: None,
            notes: None,
            test: None,
            violations: 0,
            stopped: false,
            turns: vec![Turn {
                role: Role::Lead,
                kind: TurnKind::Step,
                main: true,
            }],
            started: now(),
            ended: None,
        }
    }

    /// Any seat waits for the person.
    pub fn is_waiting(&self) -> bool {
        self.seats.values().any(|s| s.state == SeatStatus::NeedsYou)
    }

    /// `running`, `waiting`, `stopped` or `done`, as a person reads it.
    pub fn status(&self) -> &'static str {
        if self.ended.is_some() {
            "done"
        } else if self.stopped {
            "stopped"
        } else if self.is_waiting() {
            "waiting"
        } else {
            "running"
        }
    }

    pub(crate) fn seat_mut(&mut self, role: Role) -> &mut SeatState {
        self.seats
            .entry(role)
            .or_insert_with(|| SeatState::new(SeatStatus::Idle))
    }

    /// Seats an agent was killed in are idle again.
    pub(crate) fn halt(&mut self) {
        self.stopped = true;
        for seat in self.seats.values_mut() {
            if seat.state == SeatStatus::Working {
                seat.state = SeatStatus::Idle;
            }
        }
    }
}

/// What a squad did, one line of `events.jsonl`. Text is at most
/// [`TEXT_MAX`] bytes and never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at: u64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub role: Option<Role>,
    pub text: String,
}

impl Event {
    pub(crate) fn new(kind: &str, role: Option<Role>, text: &str) -> Event {
        Event {
            at: now(),
            kind: kind.to_owned(),
            role,
            text: clip(text),
        }
    }
}

/// The end of `text` in [`TEXT_MAX`] bytes; agents put their point last.
pub(crate) fn clip(text: &str) -> String {
    let text = text.trim();
    if text.len() <= TEXT_MAX {
        return text.to_owned();
    }
    format!("…{}", tail(text, TEXT_MAX - '…'.len_utf8()))
}

#[derive(Serialize, Deserialize)]
struct Note {
    role: Role,
    text: String,
}

/// Held while a process drives a squad's run; the OS lets go when the
/// process dies, so a crash never leaves a squad busy.
pub(crate) struct RunLock {
    _file: File,
}

/// Squads under `<data_dir>/squads/<id>/`. Their tasks are ordinary tasks
/// in the [`TaskStore`] of the same data dir.
#[derive(Debug, Clone)]
pub struct SquadStore {
    pub data_dir: PathBuf,
}

impl SquadStore {
    pub fn new(data_dir: impl Into<PathBuf>) -> SquadStore {
        SquadStore {
            data_dir: data_dir.into(),
        }
    }

    pub(crate) fn dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("squads").join(id)
    }

    pub(crate) fn tasks(&self) -> TaskStore {
        TaskStore::new(&self.data_dir)
    }

    /// A new squad for the repo; roles missing from `accounts` are vacant.
    pub fn create(
        &self,
        name: &str,
        repo: &Path,
        accounts: &[(Role, String)],
        test: Option<Vec<String>>,
    ) -> Result<Squad, AgentError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AgentError::EmptyName);
        }
        let repo = open_repo(&std::path::absolute(repo)?)?.root();
        let mut id = new_id(name, SystemTime::now());
        while self.dir(&id).exists() {
            id = new_id(name, SystemTime::now());
        }
        let squad = Squad {
            id,
            name: name.to_owned(),
            repo,
            seats: Role::ALL.map(|role| Seat {
                role,
                account: accounts
                    .iter()
                    .rev()
                    .find(|(r, _)| *r == role)
                    .map(|(_, a)| a.trim().to_owned())
                    .filter(|a| !a.is_empty()),
            }),
            test: test.filter(|cmd| !cmd.is_empty()),
            created: now(),
        };
        fs::create_dir_all(self.data_dir.join("squads"))?;
        fs::create_dir(self.dir(&squad.id))?;
        self.save(&squad)?;
        Ok(squad)
    }

    pub fn load(&self, id: &str) -> Result<Squad, AgentError> {
        if !valid_id(id) {
            return Err(AgentError::NotFound);
        }
        match fs::read_to_string(self.dir(id).join(SQUAD_FILE)) {
            Ok(text) => Ok(parse(&text)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(AgentError::NotFound),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, squad: &Squad) -> Result<(), AgentError> {
        write_atomic(&self.dir(&squad.id), SQUAD_FILE, &pretty(squad)?)?;
        Ok(())
    }

    /// Every readable squad, newest first.
    pub fn list(&self) -> Result<Vec<Squad>, AgentError> {
        let entries = match fs::read_dir(self.data_dir.join("squads")) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut squads = Vec::new();
        for entry in entries {
            let name = entry?.file_name();
            if let Some(squad) = name.to_str().and_then(|id| self.load(id).ok()) {
                squads.push(squad);
            }
        }
        squads.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(squads)
    }

    /// Puts an account in a seat, or empties it with `None`. Not while a run
    /// is going: its agent may be using the seat.
    pub fn set_seat(
        &self,
        id: &str,
        role: Role,
        account: Option<&str>,
    ) -> Result<Squad, AgentError> {
        let mut squad = self.load(id)?;
        let _lock = self.lock(id)?.ok_or(AgentError::Busy)?;
        let account = account.map(str::trim).filter(|a| !a.is_empty());
        for seat in &mut squad.seats {
            if seat.role == role {
                seat.account = account.map(str::to_owned);
            }
        }
        self.save(&squad)?;
        if let Some(mut run) = self.open_run(id)? {
            let seat = run.seat_mut(role);
            // A session lives in one account's config; another cannot resume it.
            seat.session = None;
            seat.context = None;
            seat.state = match (account, seat.state) {
                (None, SeatStatus::Done | SeatStatus::Skipped) => seat.state,
                (None, _) => SeatStatus::Vacant,
                (Some(_), SeatStatus::Vacant | SeatStatus::Skipped) => SeatStatus::Idle,
                (Some(_), state) => state,
            };
            self.save_run(&run)?;
        }
        self.append_event(
            id,
            &Event::new("seat", Some(role), account.unwrap_or("none")),
        )?;
        Ok(squad)
    }

    /// Deletes the squad and its runs; its tasks stay.
    pub fn remove(&self, id: &str) -> Result<(), AgentError> {
        self.load(id)?;
        let lock = self.lock(id)?.ok_or(AgentError::Busy)?;
        // An open lock file cannot be deleted on Windows.
        drop(lock);
        fs::remove_dir_all(self.dir(id))?;
        Ok(())
    }

    /// A process is driving the squad's run right now.
    pub fn is_running(&self, id: &str) -> Result<bool, AgentError> {
        self.load(id)?;
        // One try: a moment's false "running" only shows in a status.
        Ok(self.lock_with(id, 1)?.is_none())
    }

    /// The latest run, if any. A run left unfinished by a process that is
    /// gone, with no seat waiting for the person, comes back stopped and its
    /// task paused.
    pub fn current_run(&self, id: &str) -> Result<Option<SquadRun>, AgentError> {
        self.load(id)?;
        let Some(mut run) = self.latest_run(id)? else {
            return Ok(None);
        };
        if run.ended.is_none()
            && !run.stopped
            && !run.is_waiting()
            && let Some(_lock) = self.lock(id)?
        {
            run.halt();
            self.save_run(&run)?;
            self.append_event(id, &Event::new("recovered", None, "the run was stopped"))?;
            let tasks = self.tasks();
            if let Ok(mut task) = tasks.load(&run.task)
                && matches!(task.state, TaskState::Running | TaskState::Paused)
            {
                task.state = TaskState::Paused;
                tasks.save(&task)?;
            }
        }
        Ok(Some(run))
    }

    /// Every event of the squad, oldest first; a line that does not parse
    /// is skipped.
    pub fn events(&self, id: &str) -> Result<Vec<Event>, AgentError> {
        self.load(id)?;
        let text = match fs::read_to_string(self.dir(id).join(EVENTS)) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        Ok(text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect())
    }

    pub(crate) fn append_event(&self, id: &str, event: &Event) -> Result<(), AgentError> {
        let mut line = serde_json::to_string(event).map_err(io::Error::other)?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir(id).join(EVENTS))?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// `None` when another run holds the squad.
    pub(crate) fn lock(&self, id: &str) -> Result<Option<RunLock>, AgentError> {
        self.lock_with(id, LOCK_TRIES)
    }

    fn lock_with(&self, id: &str, tries: u32) -> Result<Option<RunLock>, AgentError> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dir(id).join(LOCK))?;
        // A child forked by any thread shares the lock until it execs, so a
        // lock just released can look held for a moment on Unix.
        for attempt in 0..tries {
            match file.try_lock() {
                Ok(()) => {
                    // No run is going, so a stop request left behind is for none.
                    let _ = fs::remove_file(self.dir(id).join(STOP));
                    return Ok(Some(RunLock { _file: file }));
                }
                Err(TryLockError::WouldBlock) if attempt + 1 < tries => {
                    std::thread::sleep(LOCK_WAIT)
                }
                Err(TryLockError::WouldBlock) => {}
                Err(TryLockError::Error(e)) => return Err(e.into()),
            }
        }
        Ok(None)
    }

    pub(crate) fn latest_run(&self, id: &str) -> Result<Option<SquadRun>, AgentError> {
        let entries = match fs::read_dir(self.dir(id).join("runs")) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let mut latest: Option<String> = None;
        for entry in entries {
            let name = entry?.file_name();
            let Some(task) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
                continue;
            };
            // Task ids sort by time.
            if valid_id(task) && latest.as_deref().is_none_or(|l| task > l) {
                latest = Some(task.to_owned());
            }
        }
        let Some(task) = latest else {
            return Ok(None);
        };
        let text = fs::read_to_string(self.dir(id).join("runs").join(format!("{task}.json")))?;
        Ok(Some(parse(&text)?))
    }

    /// The latest run when it has not ended.
    pub(crate) fn open_run(&self, id: &str) -> Result<Option<SquadRun>, AgentError> {
        Ok(self.latest_run(id)?.filter(|r| r.ended.is_none()))
    }

    pub(crate) fn save_run(&self, run: &SquadRun) -> Result<(), AgentError> {
        write_atomic(
            &self.dir(&run.squad).join("runs"),
            &format!("{}.json", run.task),
            &pretty(run)?,
        )?;
        Ok(())
    }

    pub(crate) fn push_inbox(&self, id: &str, role: Role, text: &str) -> Result<(), AgentError> {
        let mut line = serde_json::to_string(&Note {
            role,
            text: text.to_owned(),
        })
        .map_err(io::Error::other)?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir(id).join(INBOX))?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Takes every steer sent from elsewhere. The file is moved aside first
    /// so a steer written meanwhile lands in a new inbox, not a lost one.
    pub(crate) fn drain_inbox(&self, id: &str) -> Result<Vec<(Role, String)>, AgentError> {
        let inbox = self.dir(id).join(INBOX);
        let taken = self
            .dir(id)
            .join(format!(".{INBOX}-{}.taken", std::process::id()));
        match fs::rename(&inbox, &taken) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        }
        let text = fs::read_to_string(&taken)?;
        fs::remove_file(&taken)?;
        Ok(text
            .lines()
            .filter_map(|l| serde_json::from_str::<Note>(l).ok())
            .map(|n| (n.role, n.text))
            .collect())
    }
}

fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, AgentError> {
    Ok(serde_json::from_str(text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?)
}

fn pretty<T: Serialize>(value: &T) -> Result<String, AgentError> {
    let mut text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    text.push('\n');
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_released_lock_is_free_while_other_threads_start_processes() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let data = tempfile::tempdir().unwrap();
        let store = SquadStore::new(data.path());
        fs::create_dir_all(store.dir("s")).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let spawners: Vec<_> = (0..4)
            .map(|_| {
                let done = Arc::clone(&done);
                std::thread::spawn(move || {
                    while !done.load(Ordering::Relaxed) {
                        let _ = std::process::Command::new("git").arg("--version").output();
                    }
                })
            })
            .collect();
        let mut busy = 0;
        for _ in 0..300 {
            let lock = store.lock("s").unwrap();
            busy += usize::from(lock.is_none());
            drop(lock);
        }
        done.store(true, Ordering::Relaxed);
        for s in spawners {
            s.join().unwrap();
        }
        assert_eq!(busy, 0, "a free lock was reported busy");
    }

    #[test]
    fn roles_parse_from_their_names() {
        for role in Role::ALL {
            assert_eq!(role.as_str().parse::<Role>().unwrap(), role);
        }
        assert_eq!("boss".parse::<Role>().unwrap_err().code(), "bad_role");
    }

    #[test]
    fn json_shapes() {
        let wait = Wait::Quota {
            state: QuotaState::Reserve,
        };
        assert_eq!(
            serde_json::to_string(&wait).unwrap(),
            r#"{"kind":"quota","state":"reserve"}"#
        );
        assert_eq!(wait.text(), "quota reserve");
        let seat = SeatState::new(SeatStatus::NeedsYou);
        let json = serde_json::to_value(&seat).unwrap();
        assert_eq!(json["state"], "needs_you");
        let mut seats = BTreeMap::new();
        seats.insert(Role::Implement, 1);
        assert_eq!(serde_json::to_string(&seats).unwrap(), r#"{"implement":1}"#);
    }

    #[test]
    fn clip_keeps_the_end_within_the_limit() {
        let long = format!("{}end", "é".repeat(TEXT_MAX));
        let clipped = clip(&long);
        assert!(clipped.len() <= TEXT_MAX);
        assert!(clipped.starts_with('…'));
        assert!(clipped.ends_with("end"));
        assert_eq!(clip("  short \n"), "short");
    }
}
