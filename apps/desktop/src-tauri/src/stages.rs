//! Pipeline stages for the squad and task views. The gate logic is pure (see
//! `xdev_orch::gates`); this runs a check command, opens the person's decision
//! gate in the orchestration store and keeps the pipeline file.

use std::path::Path;
use std::process::{Command, Stdio};

use tauri::State;
use xdev_orch::{
    Evidence, GateKind, GateStatus, Need, OrchError, Pipeline, PipelineStore, StageSpec,
    StageStatus, Verdict,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::orchestration::OrchHub;

/// What a decision gate's answer says when the person approves.
const APPROVED: &str = "approved";
const DECLINED: &str = "declined";
/// Most characters of a check's output kept.
const OUTPUT_KEEP: usize = 2_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn cmd_err(e: OrchError) -> CmdError {
    CmdError {
        code: "orchestration",
        detail: Some(format!("{}: {}", e.code, e.message)),
    }
}

/// Runs the check in `cwd`; its exit code and the end of what it printed.
pub(crate) fn run_check(cwd: &Path, command: &[String]) -> Evidence {
    let Some((program, args)) = command.split_first() else {
        return Evidence::None;
    };
    match Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
    {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            let skip = text.chars().count().saturating_sub(OUTPUT_KEEP);
            Evidence::Check {
                code: out.status.code(),
                tail: text.chars().skip(skip).collect(),
            }
        }
        Err(e) => Evidence::Check {
            code: None,
            tail: e.to_string(),
        },
    }
}

/// Hands off the current stage (or retries a failed one): runs its check, or
/// opens its decision gate, and keeps the result.
pub(crate) fn advance(
    store: &PipelineStore,
    orch: &OrchHub,
    data: &Path,
    id: &str,
    retry: bool,
    run: &dyn Fn(&Path, &[String]) -> Evidence,
    now_ms: i64,
) -> Result<Pipeline, OrchError> {
    let mut p = store.load(id)?;
    let evidence = match p.need()? {
        Need::Check(command) => run(Path::new(&p.worktree), &command),
        Need::Nothing | Need::Approval(_) => Evidence::None,
    };
    let verdict = if retry {
        p.retry(&evidence)?
    } else {
        p.hand_off(&evidence)?
    };
    if verdict == Verdict::Waiting {
        let i = p.current().expect("a waiting stage is current");
        let GateKind::Approval { question } = p.stages[i].gate.clone() else {
            return Err(OrchError::bad_request("only an approval waits"));
        };
        let asker = format!("pipeline:{}", p.id);
        let gate = orch.with_store(data, |s| {
            let run = s.run_create(&format!("Pipeline {}", p.name), None, now_ms)?;
            s.gate_create(
                &run.id,
                "",
                &question,
                &[APPROVED.to_owned(), DECLINED.to_owned()],
                &asker,
                now_ms,
            )
        })?;
        p.set_gate_id(&gate.id)?;
    }
    store.save(&p)?;
    Ok(p)
}

/// The person's answer: resolves the decision gate and moves the stage.
pub(crate) fn decide(
    store: &PipelineStore,
    orch: &OrchHub,
    data: &Path,
    id: &str,
    approved: bool,
    note: Option<&str>,
    now_ms: i64,
) -> Result<Pipeline, OrchError> {
    let mut p = store.load(id)?;
    let gate = p.current().and_then(|i| p.stages[i].gate_id.clone());
    if let Some(gate) = gate {
        let said = if approved { APPROVED } else { DECLINED };
        match orch.with_store(data, |s| s.gate_resolve(&gate, said, now_ms)) {
            // Answered elsewhere already: the stage follows that answer below.
            Ok(_)
            | Err(OrchError {
                code: "invalid_transition",
                ..
            }) => {}
            Err(e) => return Err(e),
        }
    }
    p.decide(approved, note)?;
    store.save(&p)?;
    Ok(p)
}

/// A waiting approval whose decision gate was answered somewhere else (the
/// mission's gate list, `gate-resolve`) follows that answer.
pub(crate) fn sync(
    store: &PipelineStore,
    orch: &OrchHub,
    data: &Path,
    p: &mut Pipeline,
) -> Result<(), OrchError> {
    let Some(i) = p.current() else {
        return Ok(());
    };
    let (StageStatus::Waiting, Some(gate)) = (p.stages[i].status, p.stages[i].gate_id.clone())
    else {
        return Ok(());
    };
    let gate = orch.with_store(data, |s| s.gate_get(&gate))?;
    if gate.status != GateStatus::Resolved {
        return Ok(());
    }
    let said = gate.resolution.unwrap_or_default().to_lowercase();
    let approved = said.starts_with("approv") || said == "yes";
    p.decide(approved, None)?;
    store.save(p)
}

/// The pipelines of a squad or task (`subject` such as `squad:<id>`), or all.
#[tauri::command(async)]
pub fn pipelines_list(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    subject: Option<String>,
) -> Result<Vec<Pipeline>, CmdError> {
    let data = data_dir(&state)?;
    let store = PipelineStore::new(data);
    let mut all = store.list(subject.as_deref()).map_err(cmd_err)?;
    for p in &mut all {
        // A gate that cannot be read leaves the pipeline as it was.
        let _ = sync(&store, &hub, data, p);
    }
    Ok(all)
}

#[tauri::command(async)]
pub fn pipeline_new(
    state: State<'_, AppState>,
    name: String,
    subject: String,
    worktree: String,
    stages: Vec<StageSpec>,
) -> Result<Pipeline, CmdError> {
    PipelineStore::new(data_dir(&state)?)
        .create(&name, &subject, &worktree, &stages, now_ms())
        .map_err(cmd_err)
}

/// Hands the current stage's work on: its gate decides.
#[tauri::command(async)]
pub fn pipeline_hand_off(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
) -> Result<Pipeline, CmdError> {
    let data = data_dir(&state)?;
    advance(
        &PipelineStore::new(data),
        &hub,
        data,
        &id,
        false,
        &run_check,
        now_ms(),
    )
    .map_err(cmd_err)
}

/// Runs the gate of a failed stage again.
#[tauri::command(async)]
pub fn pipeline_retry(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
) -> Result<Pipeline, CmdError> {
    let data = data_dir(&state)?;
    advance(
        &PipelineStore::new(data),
        &hub,
        data,
        &id,
        true,
        &run_check,
        now_ms(),
    )
    .map_err(cmd_err)
}

/// Approves or declines the approval a stage waits on.
#[tauri::command(async)]
pub fn pipeline_decide(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    id: String,
    approved: bool,
    note: Option<String>,
) -> Result<Pipeline, CmdError> {
    let data = data_dir(&state)?;
    decide(
        &PipelineStore::new(data),
        &hub,
        data,
        &id,
        approved,
        note.as_deref(),
        now_ms(),
    )
    .map_err(cmd_err)
}

#[tauri::command(async)]
pub fn pipeline_remove(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    PipelineStore::new(data_dir(&state)?)
        .remove(&id)
        .map_err(cmd_err)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn spec(name: &str, gate: GateKind) -> StageSpec {
        StageSpec {
            name: name.to_owned(),
            gate,
        }
    }

    fn make(dir: &Path) -> (PipelineStore, Pipeline) {
        let store = PipelineStore::new(dir);
        let p = store
            .create(
                "run",
                "squad:s1",
                "/w",
                &[
                    spec("implement", GateKind::None),
                    spec(
                        "tests",
                        GateKind::Check {
                            command: vec!["t".to_owned()],
                        },
                    ),
                    spec(
                        "review",
                        GateKind::Approval {
                            question: "Ship?".to_owned(),
                        },
                    ),
                ],
                1,
            )
            .unwrap();
        (store, p)
    }

    #[test]
    fn stage_two_fails_its_check_then_a_retry_passes_and_the_approval_opens_a_gate() {
        let dir = tempfile::tempdir().unwrap();
        let (store, p) = make(dir.path());
        let hub = OrchHub::default();
        let codes = RefCell::new(vec![0, 1]);
        let run = |_: &Path, _: &[String]| Evidence::Check {
            code: codes.borrow_mut().pop(),
            tail: "boom".to_owned(),
        };
        let go = |retry| advance(&store, &hub, dir.path(), &p.id, retry, &run, 5);
        assert_eq!(go(false).unwrap().stages[0].status, StageStatus::Passed);
        let failed = go(false).unwrap();
        assert_eq!(failed.stages[1].status, StageStatus::Failed);
        assert_eq!(failed.stages[1].reason.as_deref(), Some("t exit 1: boom"));
        assert_eq!(failed.stages[2].status, StageStatus::Pending);
        // Retry is for a failed stage only; this one is failed.
        let passed = go(true).unwrap();
        assert_eq!(passed.stages[1].status, StageStatus::Passed);
        assert_eq!(go(true).unwrap_err().code, "invalid_transition");

        let waiting = go(false).unwrap();
        assert_eq!(waiting.stages[2].status, StageStatus::Waiting);
        let gate = waiting.stages[2].gate_id.clone().unwrap();
        let open = hub.with_store(dir.path(), |s| s.gate_get(&gate)).unwrap();
        assert_eq!(open.status, GateStatus::Pending);
        assert_eq!(open.question, "Ship?");

        let done = decide(&store, &hub, dir.path(), &p.id, true, None, 9).unwrap();
        assert!(done.is_done());
        let closed = hub.with_store(dir.path(), |s| s.gate_get(&gate)).unwrap();
        assert_eq!(closed.resolution.as_deref(), Some("approved"));
    }

    #[test]
    fn an_approval_answered_in_the_gate_list_moves_the_stage() {
        let dir = tempfile::tempdir().unwrap();
        let (store, p) = make(dir.path());
        let hub = OrchHub::default();
        let ok = |_: &Path, _: &[String]| Evidence::Check {
            code: Some(0),
            tail: String::new(),
        };
        for _ in 0..3 {
            advance(&store, &hub, dir.path(), &p.id, false, &ok, 5).unwrap();
        }
        let mut waiting = store.load(&p.id).unwrap();
        let gate = waiting.stages[2].gate_id.clone().unwrap();
        sync(&store, &hub, dir.path(), &mut waiting).unwrap();
        assert_eq!(waiting.stages[2].status, StageStatus::Waiting);
        hub.with_store(dir.path(), |s| s.gate_resolve(&gate, "declined", 6))
            .unwrap();
        sync(&store, &hub, dir.path(), &mut waiting).unwrap();
        assert_eq!(waiting.stages[2].status, StageStatus::Failed);
        assert_eq!(store.load(&p.id).unwrap(), waiting);
        // Deciding on a gate that was answered elsewhere does not fail.
        let again = advance(&store, &hub, dir.path(), &p.id, true, &ok, 7).unwrap();
        let gate = again.stages[2].gate_id.clone().unwrap();
        hub.with_store(dir.path(), |s| s.gate_resolve(&gate, "approved", 8))
            .unwrap();
        assert!(
            decide(&store, &hub, dir.path(), &p.id, true, None, 9)
                .unwrap()
                .is_done()
        );
    }

    #[test]
    fn a_check_that_cannot_start_does_not_pass() {
        let ev = run_check(
            Path::new("."),
            &["definitely-not-a-program-xdev".to_owned()],
        );
        assert!(matches!(ev, Evidence::Check { code: None, .. }));
        assert_eq!(run_check(Path::new("."), &[]), Evidence::None);
    }
}
