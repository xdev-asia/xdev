//! Decision gates: a question for the person (or the coordinator) that waits
//! for an answer. `ask` makes one; `gate-resolve` answers it.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::OrchError;
use crate::mail::{Identity, NewMessage};
use crate::model::{Gate, GateStatus, MessageType, Priority};
use crate::render::NEXT_RECORDED;
use crate::store::{GATE_COLS, Store, enum_text, gate_row};

/// What `ask` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswer {
    /// True while nobody has answered.
    pub pending: bool,
    pub gate_id: String,
    pub resolution: Option<String>,
    pub next: String,
}

/// The first line of a question, short enough for a subject.
fn subject_of(question: &str) -> String {
    let line = question.lines().next().unwrap_or("").trim();
    if line.chars().count() <= 80 {
        return line.to_owned();
    }
    let cut: String = line.chars().take(79).collect();
    format!("{cut}…")
}

impl Store {
    /// One gate by id.
    pub fn gate_get(&self, id: &str) -> Result<Gate, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {GATE_COLS} FROM gates WHERE id = ?1"),
                [id],
                gate_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no gate {id}")))
    }

    /// Opens a gate on `task_id` (empty when it belongs to no task); the
    /// answer goes to `asker`.
    pub fn gate_create(
        &self,
        run_id: &str,
        task_id: &str,
        question: &str,
        options: &[String],
        asker: &str,
        now_ms: i64,
    ) -> Result<Gate, OrchError> {
        if question.trim().is_empty() {
            return Err(OrchError::bad_request("a gate needs a question"));
        }
        if !task_id.is_empty() {
            let task = self.task_get(task_id)?;
            if task.run_id != run_id {
                return Err(OrchError::bad_request(format!(
                    "task {task_id} is not in run {run_id}"
                )));
            }
        }
        let id = self.next_id("gate");
        self.conn.execute(
            "INSERT INTO gates (id, run_id, task_id, question, options, status, asker, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
            params![
                id,
                run_id,
                task_id,
                question,
                serde_json::to_string(options)?,
                asker,
                now_ms
            ],
        )?;
        self.gate_get(&id)
    }

    /// The gates of a run, oldest first.
    pub fn gate_list(&self, run_id: &str, pending_only: bool) -> Result<Vec<Gate>, OrchError> {
        let only = if pending_only {
            " AND status = 'pending'"
        } else {
            ""
        };
        let mut st = self.conn.prepare(&format!(
            "SELECT {GATE_COLS} FROM gates WHERE run_id = ?1{only} ORDER BY created_ms, rowid"
        ))?;
        Ok(st
            .query_map([run_id], gate_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Answers a pending gate. A worker that asked gets the answer as a
    /// `decision_gate` message; a coordinator gets it from `ask` itself.
    pub fn gate_resolve(&self, id: &str, resolution: &str, now_ms: i64) -> Result<Gate, OrchError> {
        self.atomic(|s| Ok(s.resolve_gate(id, resolution, now_ms, None)?.0))
    }

    /// [`Store::gate_resolve`], with the answer mailed in `thread`; also
    /// gives the id of that mail (none for a coordinator's gate).
    pub(crate) fn resolve_gate(
        &self,
        id: &str,
        resolution: &str,
        now_ms: i64,
        thread: Option<String>,
    ) -> Result<(Gate, Option<String>), OrchError> {
        let gate = self.gate_get(id)?;
        if gate.status != GateStatus::Pending {
            return Err(OrchError::new(
                "invalid_transition",
                format!("gate {id} is already {}", enum_text(&gate.status)),
            ));
        }
        self.conn.execute(
            "UPDATE gates SET status = 'resolved', resolution = ?2 WHERE id = ?1",
            params![id, resolution],
        )?;
        let asker: String =
            self.conn
                .query_row("SELECT asker FROM gates WHERE id = ?1", [id], |r| r.get(0))?;
        let mut mid = None;
        if asker.starts_with("dispatch:") {
            let m = NewMessage {
                to: asker.clone(),
                kind: MessageType::DecisionGate,
                subject: format!("Decision: {}", subject_of(&gate.question)),
                body: resolution.to_owned(),
                priority: Priority::High,
                payload: Some(serde_json::json!({ "gateId": id })),
                thread,
            };
            let from = format!("run:{}", gate.run_id);
            let id = self.next_id("msg");
            self.insert_message_with_id(&id, &gate.run_id, &from, &asker, &m, now_ms)?;
            mid = Some(id);
        }
        Ok((self.gate_get(id)?, mid))
    }

    /// `ask`: a worker's question is mailed to the coordinator and the worker
    /// is told to end its turn; a coordinator's is just a gate to wait on.
    pub fn ask(
        &self,
        from: &Identity,
        question: &str,
        options: &[String],
        now_ms: i64,
    ) -> Result<AskAnswer, OrchError> {
        let task_id = match &from.dispatch {
            Some(d) => {
                self.conn
                    .query_row("SELECT task_id FROM dispatches WHERE id = ?1", [d], |r| {
                        r.get::<_, String>(0)
                    })?
            }
            None => String::new(),
        };
        let gate = self.gate_create(
            &from.run_id,
            &task_id,
            question,
            options,
            &from.address,
            now_ms,
        )?;
        if from.dispatch.is_some() {
            let m = NewMessage {
                to: format!("run:{}", from.run_id),
                kind: MessageType::Question,
                subject: subject_of(question),
                body: question.to_owned(),
                priority: Priority::High,
                payload: Some(serde_json::json!({
                    "gateId": gate.id,
                    "taskId": task_id,
                    "options": options,
                })),
                thread: None,
            };
            let mid = self.next_id("msg");
            self.insert_message_with_id(&mid, &from.run_id, &from.address, &m.to, &m, now_ms)?;
        }
        Ok(AskAnswer {
            pending: true,
            gate_id: gate.id,
            resolution: None,
            next: if from.dispatch.is_some() {
                NEXT_RECORDED.to_owned()
            } else {
                String::new()
            },
        })
    }

    /// The state of a gate as `ask --resume` reports it.
    pub fn ask_resume(&self, gate_id: &str) -> Result<AskAnswer, OrchError> {
        let g = self.gate_get(gate_id)?;
        let done = g.status != GateStatus::Pending;
        Ok(AskAnswer {
            pending: !done,
            gate_id: g.id,
            resolution: g.resolution,
            next: String::new(),
        })
    }
}
// ---------------------------------------------------------------------------
// Pipeline stages. A run is a list of ordered stages; the hand-off from one
// stage to the next passes the stage's gate first. Everything here is pure:
// the app runs the check command and opens the person's decision gate, and
// tells these functions what came of it.
// ---------------------------------------------------------------------------

/// Most stages one pipeline holds.
pub const STAGES_MAX: usize = 12;
/// Longest piece of a check's output kept in a reason.
const REASON_TAIL: usize = 300;

/// What a stage must pass before the next one starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GateKind {
    /// The hand-off goes through.
    None,
    /// A command, program first, that must exit 0.
    Check { command: Vec<String> },
    /// A person answers a decision gate.
    Approval { question: String },
}

/// A stage as it is asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StageSpec {
    pub name: String,
    pub gate: GateKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    /// Not reached yet.
    Pending,
    /// The work of the stage is under way.
    Running,
    /// Its gate waits for the person.
    Waiting,
    /// Its gate refused the hand-off; the stage stays put.
    Failed,
    Passed,
}

/// One stage of a running pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
    pub name: String,
    pub gate: GateKind,
    pub status: StageStatus,
    /// Why the gate failed, or the question it waits on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub reason: Option<String>,
    /// The decision gate an approval waits on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub gate_id: Option<String>,
    /// Hand-offs tried on this stage.
    pub attempts: u32,
}

/// Ordered stages for one squad or task run, kept in
/// `<data_dir>/pipelines/<id>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    pub id: String,
    pub name: String,
    /// What it belongs to, as `squad:<id>` or `task:<id>`.
    pub subject: String,
    /// Where check commands run.
    pub worktree: String,
    pub stages: Vec<StageRun>,
    pub created_ms: i64,
}

/// What the gate of the current stage needs before it can judge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    Nothing,
    /// Run this command and report how it exited.
    Check(Vec<String>),
    /// Open a decision gate with this question.
    Approval(String),
}

/// What the app saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Evidence {
    None,
    /// A check ran; `code` is none when it was killed or did not start.
    Check {
        code: Option<i32>,
        tail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Passed,
    Failed(String),
    Waiting,
}

/// Judges one gate. A check passes only on exit 0, and a check that left no
/// evidence has not passed.
pub fn judge(gate: &GateKind, evidence: &Evidence) -> Verdict {
    match (gate, evidence) {
        (GateKind::None, _) => Verdict::Passed,
        (GateKind::Approval { .. }, _) => Verdict::Waiting,
        (GateKind::Check { command }, Evidence::Check { code, tail }) => match code {
            Some(0) => Verdict::Passed,
            Some(n) => Verdict::Failed(reason_of(command, &format!("exit {n}"), tail)),
            None => Verdict::Failed(reason_of(command, "did not finish", tail)),
        },
        (GateKind::Check { command }, Evidence::None) => {
            Verdict::Failed(reason_of(command, "did not run", ""))
        }
    }
}

fn reason_of(command: &[String], what: &str, tail: &str) -> String {
    let head = format!("{} {what}", command.first().map_or("check", String::as_str));
    let tail = tail.trim();
    if tail.is_empty() {
        return head;
    }
    let skip = tail.chars().count().saturating_sub(REASON_TAIL);
    let cut: String = tail.chars().skip(skip).collect();
    format!("{head}: {}{cut}", if skip > 0 { "…" } else { "" })
}

fn invalid(message: impl Into<String>) -> OrchError {
    OrchError::new("invalid_transition", message)
}

impl Pipeline {
    /// Stages in order; the first one starts running. A stage needs a name,
    /// and a check needs a program.
    pub fn new(
        id: &str,
        name: &str,
        subject: &str,
        worktree: &str,
        specs: &[StageSpec],
        now_ms: i64,
    ) -> Result<Pipeline, OrchError> {
        if specs.is_empty() || specs.len() > STAGES_MAX {
            return Err(OrchError::bad_request(format!(
                "a pipeline has 1 to {STAGES_MAX} stages"
            )));
        }
        for spec in specs {
            if spec.name.trim().is_empty() {
                return Err(OrchError::bad_request("a stage needs a name"));
            }
            match &spec.gate {
                GateKind::Check { command }
                    if command.first().is_none_or(|p| p.trim().is_empty()) =>
                {
                    return Err(OrchError::bad_request(format!(
                        "the check of {} needs a command",
                        spec.name.trim()
                    )));
                }
                GateKind::Approval { question } if question.trim().is_empty() => {
                    return Err(OrchError::bad_request(format!(
                        "the approval of {} needs a question",
                        spec.name.trim()
                    )));
                }
                _ => {}
            }
        }
        let mut stages: Vec<StageRun> = specs
            .iter()
            .map(|s| StageRun {
                name: s.name.trim().to_owned(),
                gate: s.gate.clone(),
                status: StageStatus::Pending,
                reason: None,
                gate_id: None,
                attempts: 0,
            })
            .collect();
        stages[0].status = StageStatus::Running;
        Ok(Pipeline {
            id: id.to_owned(),
            name: name.trim().to_owned(),
            subject: subject.to_owned(),
            worktree: worktree.to_owned(),
            stages,
            created_ms: now_ms,
        })
    }

    /// The first stage that has not passed; none once all have.
    pub fn current(&self) -> Option<usize> {
        self.stages
            .iter()
            .position(|s| s.status != StageStatus::Passed)
    }

    pub fn is_done(&self) -> bool {
        self.current().is_none()
    }

    /// What the current stage's gate needs before [`Pipeline::hand_off`].
    pub fn need(&self) -> Result<Need, OrchError> {
        let i = self
            .current()
            .ok_or_else(|| invalid("every stage has passed"))?;
        let stage = &self.stages[i];
        match stage.status {
            StageStatus::Running | StageStatus::Failed => Ok(match &stage.gate {
                GateKind::None => Need::Nothing,
                GateKind::Check { command } => Need::Check(command.clone()),
                GateKind::Approval { question } => Need::Approval(question.clone()),
            }),
            _ => Err(invalid(format!("{} is waiting on its gate", stage.name))),
        }
    }

    /// Hands the current stage's work to the next stage: its gate judges the
    /// evidence. A pass starts the next stage; a failure keeps this one and
    /// says why; an approval waits for [`Pipeline::decide`]. Doing it again
    /// on a failed stage is the retry.
    pub fn hand_off(&mut self, evidence: &Evidence) -> Result<Verdict, OrchError> {
        self.need()?;
        let i = self.current().expect("need() found a stage");
        let verdict = judge(&self.stages[i].gate, evidence);
        self.stages[i].attempts += 1;
        self.apply(i, &verdict);
        Ok(verdict)
    }

    /// The same hand-off, but only for a stage whose gate failed.
    pub fn retry(&mut self, evidence: &Evidence) -> Result<Verdict, OrchError> {
        match self.current().map(|i| self.stages[i].status) {
            Some(StageStatus::Failed) => self.hand_off(evidence),
            _ => Err(invalid("no stage has failed its gate")),
        }
    }

    /// Records the decision gate an approval opened.
    pub fn set_gate_id(&mut self, id: &str) -> Result<(), OrchError> {
        let i = self
            .current()
            .ok_or_else(|| invalid("every stage has passed"))?;
        if self.stages[i].status != StageStatus::Waiting {
            return Err(invalid(format!(
                "{} waits on no approval",
                self.stages[i].name
            )));
        }
        self.stages[i].gate_id = Some(id.to_owned());
        Ok(())
    }

    /// The person's answer to a waiting approval.
    pub fn decide(&mut self, approved: bool, note: Option<&str>) -> Result<Verdict, OrchError> {
        let i = self
            .current()
            .ok_or_else(|| invalid("every stage has passed"))?;
        if self.stages[i].status != StageStatus::Waiting {
            return Err(invalid(format!(
                "{} waits on no approval",
                self.stages[i].name
            )));
        }
        let verdict = if approved {
            Verdict::Passed
        } else {
            let note = note.map(str::trim).filter(|n| !n.is_empty());
            Verdict::Failed(
                note.map_or_else(|| "declined".to_owned(), |n| format!("declined: {n}")),
            )
        };
        self.apply(i, &verdict);
        Ok(verdict)
    }

    fn apply(&mut self, i: usize, verdict: &Verdict) {
        let stage = &mut self.stages[i];
        stage.gate_id = None;
        match verdict {
            Verdict::Passed => {
                stage.status = StageStatus::Passed;
                stage.reason = None;
                if let Some(next) = self.stages.get_mut(i + 1) {
                    next.status = StageStatus::Running;
                }
            }
            Verdict::Failed(why) => {
                stage.status = StageStatus::Failed;
                stage.reason = Some(why.clone());
            }
            Verdict::Waiting => {
                stage.status = StageStatus::Waiting;
                stage.reason = match &stage.gate {
                    GateKind::Approval { question } => Some(question.clone()),
                    _ => None,
                };
            }
        }
    }
}

/// Pipelines in `<data_dir>/pipelines/`, one file each.
#[derive(Debug, Clone)]
pub struct PipelineStore {
    dir: std::path::PathBuf,
}

fn valid_pipeline_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn io_err(e: impl std::fmt::Display) -> OrchError {
    OrchError::new("store", e.to_string())
}

impl PipelineStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> PipelineStore {
        PipelineStore {
            dir: data_dir.as_ref().join("pipelines"),
        }
    }

    /// A new pipeline under a fresh id.
    pub fn create(
        &self,
        name: &str,
        subject: &str,
        worktree: &str,
        specs: &[StageSpec],
        now_ms: i64,
    ) -> Result<Pipeline, OrchError> {
        let mut id = format!("pl-{now_ms:x}");
        let mut n = 1;
        while self.path(&id).exists() {
            n += 1;
            id = format!("pl-{now_ms:x}-{n}");
        }
        let pipeline = Pipeline::new(&id, name, subject, worktree, specs, now_ms)?;
        self.save(&pipeline)?;
        Ok(pipeline)
    }

    fn path(&self, id: &str) -> std::path::PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    pub fn load(&self, id: &str) -> Result<Pipeline, OrchError> {
        if !valid_pipeline_id(id) {
            return Err(OrchError::not_found(format!("no pipeline {id}")));
        }
        match std::fs::read_to_string(self.path(id)) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(OrchError::not_found(format!("no pipeline {id}")))
            }
            Err(e) => Err(io_err(e)),
        }
    }

    pub fn save(&self, pipeline: &Pipeline) -> Result<(), OrchError> {
        if !valid_pipeline_id(&pipeline.id) {
            return Err(OrchError::bad_request("a bad pipeline id"));
        }
        std::fs::create_dir_all(&self.dir).map_err(io_err)?;
        let tmp = self.dir.join(format!(".{}.tmp", pipeline.id));
        let mut text = serde_json::to_string_pretty(pipeline)?;
        text.push('\n');
        std::fs::write(&tmp, text).map_err(io_err)?;
        std::fs::rename(&tmp, self.path(&pipeline.id)).map_err(io_err)
    }

    /// Every readable pipeline, newest first; `subject` narrows them.
    pub fn list(&self, subject: Option<&str>) -> Result<Vec<Pipeline>, OrchError> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err(e)),
        };
        let mut out: Vec<Pipeline> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                self.load(name.strip_suffix(".json")?).ok()
            })
            .filter(|p| subject.is_none_or(|s| p.subject == s))
            .collect();
        out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then(b.id.cmp(&a.id)));
        Ok(out)
    }

    pub fn remove(&self, id: &str) -> Result<(), OrchError> {
        self.load(id)?;
        std::fs::remove_file(self.path(id)).map_err(io_err)
    }
}

#[cfg(test)]
mod stage_tests {
    use super::*;

    fn spec(name: &str, gate: GateKind) -> StageSpec {
        StageSpec {
            name: name.to_owned(),
            gate,
        }
    }

    fn check(program: &str) -> GateKind {
        GateKind::Check {
            command: vec![program.to_owned()],
        }
    }

    fn three() -> Pipeline {
        Pipeline::new(
            "pl-1",
            "ship it",
            "squad:s1",
            "/w",
            &[
                spec("implement", GateKind::None),
                spec("tests", check("cargo")),
                spec(
                    "review",
                    GateKind::Approval {
                        question: "Ship?".to_owned(),
                    },
                ),
            ],
            1,
        )
        .unwrap()
    }

    fn exit(code: i32, tail: &str) -> Evidence {
        Evidence::Check {
            code: Some(code),
            tail: tail.to_owned(),
        }
    }

    fn statuses(p: &Pipeline) -> Vec<StageStatus> {
        p.stages.iter().map(|s| s.status).collect()
    }

    #[test]
    fn a_new_pipeline_starts_its_first_stage() {
        use StageStatus::*;
        let p = three();
        assert_eq!(statuses(&p), [Running, Pending, Pending]);
        assert_eq!(p.current(), Some(0));
        assert!(!p.is_done());
    }

    #[test]
    fn a_gate_of_none_hands_off_at_once() {
        use StageStatus::*;
        let mut p = three();
        assert_eq!(p.need().unwrap(), Need::Nothing);
        assert_eq!(p.hand_off(&Evidence::None).unwrap(), Verdict::Passed);
        assert_eq!(statuses(&p), [Passed, Running, Pending]);
        assert_eq!(p.need().unwrap(), Need::Check(vec!["cargo".to_owned()]));
    }

    #[test]
    fn a_failed_check_keeps_the_stage_and_says_why_then_retry_passes() {
        use StageStatus::*;
        let mut p = three();
        p.hand_off(&Evidence::None).unwrap();
        let v = p.hand_off(&exit(101, "1 test failed")).unwrap();
        assert_eq!(
            v,
            Verdict::Failed("cargo exit 101: 1 test failed".to_owned())
        );
        assert_eq!(statuses(&p), [Passed, Failed, Pending]);
        assert_eq!(
            p.stages[1].reason.as_deref(),
            Some("cargo exit 101: 1 test failed")
        );
        assert_eq!(p.current(), Some(1));
        // Stage 3 cannot start while stage 2 holds.
        assert_eq!(p.stages[2].status, Pending);
        assert_eq!(p.retry(&exit(0, "")).unwrap(), Verdict::Passed);
        assert_eq!(statuses(&p), [Passed, Passed, Running]);
        assert_eq!(p.stages[1].reason, None);
        assert_eq!(p.stages[1].attempts, 2);
    }

    #[test]
    fn retry_needs_a_failed_stage() {
        let mut p = three();
        assert_eq!(
            p.retry(&Evidence::None).unwrap_err().code,
            "invalid_transition"
        );
    }

    #[test]
    fn a_check_with_no_exit_code_or_no_evidence_has_not_passed() {
        let gate = check("make");
        assert_eq!(
            judge(
                &gate,
                &Evidence::Check {
                    code: None,
                    tail: String::new()
                }
            ),
            Verdict::Failed("make did not finish".to_owned())
        );
        assert_eq!(
            judge(&gate, &Evidence::None),
            Verdict::Failed("make did not run".to_owned())
        );
        assert_eq!(judge(&gate, &exit(0, "")), Verdict::Passed);
    }

    #[test]
    fn a_long_output_keeps_its_end() {
        let tail = format!("{}end", "x".repeat(1000));
        let Verdict::Failed(why) = judge(&check("t"), &exit(1, &tail)) else {
            panic!("should fail");
        };
        assert!(why.starts_with("t exit 1: …"));
        assert!(why.ends_with("end"));
        assert!(why.chars().count() < 330);
    }

    #[test]
    fn an_approval_waits_and_the_person_decides() {
        use StageStatus::*;
        let mut p = three();
        p.hand_off(&Evidence::None).unwrap();
        p.hand_off(&exit(0, "")).unwrap();
        assert_eq!(p.need().unwrap(), Need::Approval("Ship?".to_owned()));
        assert_eq!(p.hand_off(&Evidence::None).unwrap(), Verdict::Waiting);
        assert_eq!(statuses(&p), [Passed, Passed, Waiting]);
        assert_eq!(p.stages[2].reason.as_deref(), Some("Ship?"));
        p.set_gate_id("gate_1").unwrap();
        assert_eq!(p.stages[2].gate_id.as_deref(), Some("gate_1"));
        // While it waits, a second hand-off is refused.
        assert_eq!(
            p.hand_off(&Evidence::None).unwrap_err().code,
            "invalid_transition"
        );
        // Declined stays put with the note; handing off again asks again.
        assert_eq!(
            p.decide(false, Some(" not yet ")).unwrap(),
            Verdict::Failed("declined: not yet".to_owned())
        );
        assert_eq!(statuses(&p), [Passed, Passed, Failed]);
        assert_eq!(p.stages[2].gate_id, None);
        p.retry(&Evidence::None).unwrap();
        assert_eq!(p.decide(true, None).unwrap(), Verdict::Passed);
        assert!(p.is_done());
        assert_eq!(p.need().unwrap_err().code, "invalid_transition");
        assert_eq!(p.decide(true, None).unwrap_err().code, "invalid_transition");
    }

    #[test]
    fn deciding_needs_a_waiting_approval() {
        let mut p = three();
        assert_eq!(p.decide(true, None).unwrap_err().code, "invalid_transition");
        assert_eq!(p.set_gate_id("g").unwrap_err().code, "invalid_transition");
    }

    #[test]
    fn bad_stage_lists_are_refused() {
        let new = |specs: &[StageSpec]| Pipeline::new("pl", "n", "task:1", "/w", specs, 0);
        assert_eq!(new(&[]).unwrap_err().code, "bad_request");
        assert_eq!(
            new(&[spec(" ", GateKind::None)]).unwrap_err().code,
            "bad_request"
        );
        assert_eq!(
            new(&[spec("a", GateKind::Check { command: vec![] })])
                .unwrap_err()
                .code,
            "bad_request"
        );
        assert_eq!(
            new(&[spec(
                "a",
                GateKind::Approval {
                    question: " ".to_owned()
                }
            )])
            .unwrap_err()
            .code,
            "bad_request"
        );
        let many: Vec<StageSpec> = (0..=STAGES_MAX)
            .map(|i| spec(&format!("s{i}"), GateKind::None))
            .collect();
        assert_eq!(new(&many).unwrap_err().code, "bad_request");
    }

    #[test]
    fn the_gate_json_shape() {
        assert_eq!(
            serde_json::to_string(&GateKind::None).unwrap(),
            r#"{"kind":"none"}"#
        );
        assert_eq!(
            serde_json::to_string(&check("make")).unwrap(),
            r#"{"kind":"check","command":["make"]}"#
        );
    }

    #[test]
    fn pipelines_are_kept_listed_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let store = PipelineStore::new(dir.path());
        assert!(store.list(None).unwrap().is_empty());
        let specs = [spec("a", GateKind::None)];
        let one = store.create("one", "squad:s1", "/w", &specs, 10).unwrap();
        let two = store.create("two", "task:t1", "/w", &specs, 20).unwrap();
        let same = store
            .create("same tick", "task:t1", "/w", &specs, 20)
            .unwrap();
        assert_ne!(two.id, same.id);
        assert_eq!(store.load(&one.id).unwrap(), one);
        assert_eq!(store.list(None).unwrap().len(), 3);
        assert_eq!(store.list(Some("squad:s1")).unwrap(), vec![one.clone()]);
        let mut moved = one.clone();
        moved.hand_off(&Evidence::None).unwrap();
        store.save(&moved).unwrap();
        assert!(store.load(&one.id).unwrap().is_done());
        store.remove(&one.id).unwrap();
        assert_eq!(store.load(&one.id).unwrap_err().code, "not_found");
        assert_eq!(store.load("../x").unwrap_err().code, "not_found");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::CheckOpts;

    fn world() -> (Store, Identity, Identity, String) {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("o", Some("lead"), 1).unwrap();
        let task = s
            .task_create(
                &run.id,
                crate::NewTask {
                    title: None,
                    spec: "s".into(),
                    deps: vec![],
                    parent: None,
                },
                1,
            )
            .unwrap();
        s.conn
            .execute_batch(&format!(
                "INSERT INTO dispatches (id, run_id, task_id, status) VALUES ('disp_a', '{r}', '{t}', 'dispatched');
                 INSERT INTO workers (dispatch_id, tab, worktree, agent, state, created_ms, updated_ms)
                   VALUES ('disp_a', 'tab_a', '/wt/a', 'claude', 'ready', 1, 1);",
                r = run.id,
                t = task.id
            ))
            .unwrap();
        let lead = s.identity(Some("lead"), None).unwrap();
        let worker = s.identity(Some("tab_a"), None).unwrap();
        (s, lead, worker, task.id)
    }

    #[test]
    fn a_worker_ask_mails_the_coordinator_and_returns_at_once() {
        let (s, lead, worker, task) = world();
        let a = s
            .ask(
                &worker,
                "Pick one?\nlong text",
                &["x".into(), "y".into()],
                5,
            )
            .unwrap();
        assert!(a.pending);
        assert_eq!(a.next, NEXT_RECORDED);
        let g = s.gate_get(&a.gate_id).unwrap();
        assert_eq!(g.task_id, task);
        assert_eq!(g.options, vec!["x", "y"]);
        let mail = s.check(&lead.address, &CheckOpts::default(), 6).unwrap();
        assert_eq!(mail.messages.len(), 1);
        assert_eq!(mail.messages[0].kind, MessageType::Question);
        assert_eq!(mail.messages[0].subject, "Pick one?");
        assert_eq!(
            mail.messages[0].payload.as_ref().unwrap()["gateId"],
            a.gate_id
        );
    }

    #[test]
    fn resolving_sends_the_worker_a_decision_and_only_once() {
        let (s, _lead, worker, _) = world();
        let a = s.ask(&worker, "which?", &[], 5).unwrap();
        assert!(s.ask_resume(&a.gate_id).unwrap().pending);
        let g = s.gate_resolve(&a.gate_id, "sqlite", 7).unwrap();
        assert_eq!(g.status, GateStatus::Resolved);
        assert_eq!(g.resolution.as_deref(), Some("sqlite"));
        let back = s.check(&worker.address, &CheckOpts::default(), 8).unwrap();
        assert_eq!(back.messages.len(), 1);
        assert_eq!(back.messages[0].kind, MessageType::DecisionGate);
        assert_eq!(back.messages[0].body, "sqlite");
        assert_eq!(back.messages[0].priority, Priority::High);
        let again = s.gate_resolve(&a.gate_id, "no", 9);
        assert_eq!(again.unwrap_err().code, "invalid_transition");
        let r = s.ask_resume(&a.gate_id).unwrap();
        assert!(!r.pending);
        assert_eq!(r.resolution.as_deref(), Some("sqlite"));
    }

    #[test]
    fn replying_to_a_question_resolves_its_gate_and_mails_the_answer_once() {
        let (s, lead, worker, _) = world();
        let a = s.ask(&worker, "which db?", &[], 5).unwrap();
        let mail = s.check(&lead.address, &CheckOpts::default(), 6).unwrap();
        let q_id = mail.messages[0].id.clone();
        let rep = s.reply(&lead, &q_id, "sqlite", 7).unwrap();
        assert_eq!(rep.count, 1);
        let r = s.ask_resume(&a.gate_id).unwrap();
        assert!(!r.pending);
        assert_eq!(r.resolution.as_deref(), Some("sqlite"));
        let back = s.check(&worker.address, &CheckOpts::default(), 8).unwrap();
        assert_eq!(back.messages.len(), 1);
        assert_eq!(back.messages[0].kind, MessageType::DecisionGate);
        assert_eq!(back.messages[0].body, "sqlite");
        assert_eq!(back.messages[0].thread_id.as_deref(), Some(q_id.as_str()));
        assert_eq!(back.messages[0].id, rep.ids[0]);
        // A second reply to an answered question is plain mail.
        let again = s.reply(&lead, &q_id, "or not", 9).unwrap();
        assert_eq!(again.count, 1);
        assert_eq!(
            s.ask_resume(&a.gate_id).unwrap().resolution.as_deref(),
            Some("sqlite")
        );
        let late = s.check(&worker.address, &CheckOpts::default(), 10).unwrap();
        assert_eq!(late.messages[0].kind, MessageType::Status);
    }

    #[test]
    fn a_coordinator_ask_sends_no_mail_and_gets_the_answer_from_resume() {
        let (s, lead, _worker, _) = world();
        let a = s.ask(&lead, "ship it?", &[], 5).unwrap();
        assert!(a.pending);
        assert_eq!(a.next, "");
        s.gate_resolve(&a.gate_id, "yes", 6).unwrap();
        assert_eq!(s.unread_count(&lead.address).unwrap(), 0);
        assert_eq!(
            s.ask_resume(&a.gate_id).unwrap().resolution.as_deref(),
            Some("yes")
        );
    }

    #[test]
    fn gates_list_by_run_and_reject_bad_input() {
        let (s, lead, _worker, task) = world();
        let g1 = s
            .gate_create(&lead.run_id, &task, "q1", &[], &lead.address, 1)
            .unwrap();
        s.gate_create(&lead.run_id, "", "q2", &[], &lead.address, 2)
            .unwrap();
        assert_eq!(s.gate_list(&lead.run_id, true).unwrap().len(), 2);
        s.gate_resolve(&g1.id, "a", 3).unwrap();
        assert_eq!(s.gate_list(&lead.run_id, true).unwrap().len(), 1);
        assert_eq!(s.gate_list(&lead.run_id, false).unwrap().len(), 2);
        let empty = s.gate_create(&lead.run_id, "", "  ", &[], &lead.address, 1);
        assert_eq!(empty.unwrap_err().code, "bad_request");
        let ghost = s.gate_create(&lead.run_id, "task_nope", "q", &[], &lead.address, 1);
        assert_eq!(ghost.unwrap_err().code, "not_found");
        assert_eq!(s.gate_get("gate_nope").unwrap_err().code, "not_found");
        assert_eq!(s.run_show(&lead.run_id).unwrap().open_gates, 1);
    }
}
