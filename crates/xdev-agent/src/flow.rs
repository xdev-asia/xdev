use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime};

use xdev_git::{GitError, Repo};
use xdev_policy::{Action, Gate, Verdict};

use crate::id::new_id;
use crate::process::capture;
use crate::store::LiveGuard;
use crate::{
    AgentError, Approval, Cancel, DEFAULT_TOOLS, Evidence, FileChange, RunOutcome, RunRecord,
    RunRequest, Runner, Task, TaskState, TaskStore, TestResult, now, tail,
};

pub(crate) const SUMMARY_TAIL: usize = 2000;
const OUTPUT_TAIL: usize = 4000;
/// A test suite that runs longer than this is treated as hung.
const TEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// What a run may use. Empty `tools` means [`DEFAULT_TOOLS`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOptions {
    /// The account name the gate sees; the runner already holds its folder.
    pub account: Option<String>,
    pub tools: Vec<String>,
    /// Program and arguments, run in the worktree after the agent.
    pub test: Option<Vec<String>>,
}

impl TaskStore {
    /// A task on a new branch `xdev/task-<id>` from the repo's `HEAD`, in its
    /// own worktree.
    pub fn new_task(&self, repo: &Path, goal: &str) -> Result<Task, AgentError> {
        let goal = goal.trim();
        if goal.is_empty() {
            return Err(AgentError::EmptyGoal);
        }
        let repo = open_repo(&std::path::absolute(repo)?)?;
        let root = repo.root();
        let base = repo.head_id()?.ok_or(AgentError::NoCommits)?;

        let mut id = new_id(goal, SystemTime::now());
        // Same goal in the same nanosecond is the only way to collide; a
        // new clock reading gives a new tail.
        while self.data_dir.join("tasks").join(&id).exists() || self.worktree_path(&id).exists() {
            id = new_id(goal, SystemTime::now());
        }
        let worktree = self.worktree_path(&id);
        fs::create_dir_all(self.local_dir.join("worktrees"))?;
        let branch = format!("xdev/task-{id}");
        repo.add_worktree(&worktree, &branch, &base)?;

        let task = Task {
            id,
            goal: goal.to_owned(),
            repo: root,
            base,
            branch,
            worktree,
            state: TaskState::Ready,
            runs: Vec::new(),
            evidence: None,
            approval: None,
            created: now(),
        };
        if let Err(e) = self.create(&task) {
            // A worktree with no record could never be listed or discarded.
            let _ = repo.remove_worktree(&task.worktree);
            let _ = repo.delete_branch(&task.branch);
            return Err(e);
        }
        Ok(task)
    }

    /// Runs the agent on a `ready`, `paused` or `failed` task, then commits
    /// its changes, runs the test and stores the evidence.
    pub fn run_task(
        &self,
        id: &str,
        runner: &dyn Runner,
        gate: &dyn Gate,
        opts: &RunOptions,
    ) -> Result<Task, AgentError> {
        let task = self.load(id)?;
        if !matches!(
            task.state,
            TaskState::Ready | TaskState::Paused | TaskState::Failed
        ) {
            return Err(AgentError::BadState(task.state.as_str()));
        }
        self.execute(task, None, runner, gate, opts)
    }

    /// Continues the last session of a `paused` or `failed` task.
    pub fn resume_task(
        &self,
        id: &str,
        runner: &dyn Runner,
        gate: &dyn Gate,
        opts: &RunOptions,
    ) -> Result<Task, AgentError> {
        let task = self.load(id)?;
        if !matches!(task.state, TaskState::Paused | TaskState::Failed) {
            return Err(AgentError::BadState(task.state.as_str()));
        }
        let session = task.last_session().ok_or(AgentError::NoSession)?.to_owned();
        self.execute(task, Some(session), runner, gate, opts)
    }

    fn execute(
        &self,
        mut task: Task,
        resume: Option<String>,
        runner: &dyn Runner,
        gate: &dyn Gate,
        opts: &RunOptions,
    ) -> Result<Task, AgentError> {
        let tools: Vec<String> = if opts.tools.is_empty() {
            DEFAULT_TOOLS.iter().map(|t| (*t).to_owned()).collect()
        } else {
            opts.tools.clone()
        };
        allow(gate.check(&Action::SpawnAgent {
            provider: runner.provider().to_owned(),
            account: opts.account.clone(),
            worktree: task.worktree.clone(),
            tools: tools.clone(),
        }))?;
        let test = opts.test.as_ref().filter(|t| !t.is_empty());
        // Checked before the agent starts, so a test that may not run never
        // costs a run whose evidence would lack it.
        if let Some(test) = test {
            allow(gate.check(&Action::RunCommand {
                program: test[0].clone(),
                args: test[1..].to_vec(),
                cwd: task.worktree.clone(),
            }))?;
        }
        if !task.worktree.is_dir() {
            return Err(AgentError::NoWorktree);
        }

        let _live = LiveGuard::take(&task.id).ok_or(AgentError::BadState("running"))?;
        task.state = TaskState::Running;
        task.runs.push(RunRecord {
            started: now(),
            ended: None,
            session_id: resume.clone(),
            cost_usd: None,
            is_error: false,
            summary: String::new(),
        });
        self.save(&task)?;

        let prompt = match resume {
            Some(_) => "Continue where you stopped and finish the task.".to_owned(),
            None => prompt(&task.goal),
        };
        let req = RunRequest {
            worktree: task.worktree.clone(),
            prompt,
            resume,
            tools,
            cancel: Cancel::new(),
        };
        let result = runner.run(&req);
        let outcome = record_run(&mut task, result);
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(e) => {
                self.save(&task)?;
                return Err(e);
            }
        };

        match finish(&mut task, test.map(Vec::as_slice), outcome.is_error) {
            Ok(()) => {
                self.save(&task)?;
                Ok(task)
            }
            Err(e) => {
                task.state = TaskState::Failed;
                self.save(&task)?;
                Err(e)
            }
        }
    }

    /// Merges a task in `review` into the repo's current branch. Calling this
    /// is the person's approval, so a gate's `Ask` proceeds; `Deny` does not.
    pub fn approve_task(&self, id: &str, gate: &dyn Gate) -> Result<Task, AgentError> {
        let mut task = self.load(id)?;
        if task.state != TaskState::Review {
            return Err(AgentError::BadState(task.state.as_str()));
        }
        let repo = open_repo(&task.repo)?;
        let into = repo.current_branch()?.ok_or(AgentError::Detached)?;
        let verdict = gate.check(&Action::Merge {
            from: task.branch.clone(),
            into,
        });
        if let Verdict::Deny { .. } = verdict {
            return Err(AgentError::Gated(verdict));
        }
        if !repo.is_clean()? {
            return Err(AgentError::DirtyRepo);
        }
        // Git joins a subject's lines, so a long goal goes in the body.
        let first_line = task.goal.lines().next().unwrap_or_default();
        let mut message = format!("Merge task {}: {first_line}", task.id);
        if task.goal.trim() != first_line {
            message = format!("{message}\n\n{}", task.goal);
        }
        let merge_commit = repo
            .merge_no_ff(&task.branch, &message)?
            .ok_or(AgentError::MergeConflict)?;
        task.approval = Some(Approval {
            at: now(),
            merge_commit,
        });
        task.state = TaskState::Merged;
        self.save(&task)?;
        // The merge is done and recorded; a worktree left behind only takes
        // space in the data folder and is pruned once the folder goes.
        let _ = repo.remove_worktree(&task.worktree);
        Ok(task)
    }

    /// Removes the worktree and the task branch. The record stays.
    pub fn discard_task(&self, id: &str) -> Result<Task, AgentError> {
        let mut task = self.load(id)?;
        if matches!(
            task.state,
            TaskState::Running | TaskState::Merged | TaskState::Discarded
        ) {
            return Err(AgentError::BadState(task.state.as_str()));
        }
        match open_repo(&task.repo) {
            Ok(repo) => {
                repo.remove_worktree(&task.worktree)?;
                repo.delete_branch(&task.branch)?;
            }
            // With the repo gone there is no branch to delete, but the
            // folder in the data dir is still ours to clear.
            Err(AgentError::NoRepo) => {
                if task.worktree.exists() {
                    fs::remove_dir_all(&task.worktree)?;
                }
            }
            Err(e) => return Err(e),
        }
        task.state = TaskState::Discarded;
        self.save(&task)?;
        Ok(task)
    }
}

pub(crate) fn open_repo(dir: &Path) -> Result<Repo, AgentError> {
    match Repo::discover(dir) {
        Ok(repo) => Ok(repo),
        Err(GitError::NoRepo) => Err(AgentError::NoRepo),
        Err(GitError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(AgentError::NoRepo),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn allow(verdict: Verdict) -> Result<(), AgentError> {
    match verdict {
        Verdict::Allow => Ok(()),
        other => Err(AgentError::Gated(other)),
    }
}

fn prompt(goal: &str) -> String {
    format!(
        "{goal}\n\n\
         You are working in a git worktree made for this task. Change files in \
         this folder only. Do not commit, push or switch branches: xDev commits \
         your changes for a person to review."
    )
}

/// Fills in the run just started. A timeout or stop with a known session
/// leaves the task `paused` so it can be resumed; any other failure is
/// `failed`.
fn record_run(
    task: &mut Task,
    result: Result<RunOutcome, AgentError>,
) -> Result<RunOutcome, AgentError> {
    let run = task.runs.last_mut().expect("a run was pushed");
    fill_run(run, &result);
    if let Err(e) = &result {
        task.state = if killed(e) && run.session_id.is_some() {
            TaskState::Paused
        } else {
            TaskState::Failed
        };
    }
    result
}

fn killed(e: &AgentError) -> bool {
    matches!(e, AgentError::Timeout { .. } | AgentError::Stopped { .. })
}

pub(crate) fn fill_run(run: &mut RunRecord, result: &Result<RunOutcome, AgentError>) {
    run.ended = Some(now());
    match result {
        Ok(outcome) => {
            if outcome.session_id.is_some() {
                run.session_id.clone_from(&outcome.session_id);
            }
            run.cost_usd = outcome.cost_usd;
            run.is_error = outcome.is_error;
            run.summary = tail(&outcome.result, SUMMARY_TAIL);
        }
        Err(e) => {
            if let Some(id) = killed_session(e) {
                run.session_id = Some(id.to_owned());
            }
            run.is_error = true;
            run.summary = tail(&e.to_string(), SUMMARY_TAIL);
        }
    }
}

/// The session a killed agent left behind, which can be resumed.
pub(crate) fn killed_session(e: &AgentError) -> Option<&str> {
    match e {
        AgentError::Timeout { session_id } | AgentError::Stopped { session_id } => {
            session_id.as_deref()
        }
        _ => None,
    }
}

fn finish(task: &mut Task, test: Option<&[String]>, is_error: bool) -> Result<(), AgentError> {
    commit(task, None)?;
    let test = test.map(|cmd| run_test(cmd, &task.worktree, &Cancel::new()));
    task.evidence = Some(evidence(task, test)?);
    task.state = if is_error {
        TaskState::Failed
    } else {
        TaskState::Review
    };
    Ok(())
}

/// Commits everything in the task's worktree; `label` names who changed it.
/// Nothing to commit is not an error.
pub(crate) fn commit(task: &Task, label: Option<&str>) -> Result<(), AgentError> {
    let worktree = Repo::discover(&task.worktree)?;
    let first_line = task.goal.lines().next().unwrap_or_default();
    let message = match label {
        Some(label) => format!("task {} ({label}): {first_line}", task.id),
        None => format!("task {}: {first_line}", task.id),
    };
    worktree.commit_all(&message)?;
    Ok(())
}

/// The task's committed changes since its base, with the test result.
pub(crate) fn evidence(task: &Task, test: Option<TestResult>) -> Result<Evidence, AgentError> {
    let worktree = Repo::discover(&task.worktree)?;
    let head = worktree.head_id()?.unwrap_or_else(|| task.base.clone());
    let files = worktree
        .diff_numstat(&task.base, &head)?
        .into_iter()
        .map(|f| FileChange {
            path: f.path,
            added: f.added,
            removed: f.removed,
        })
        .collect();
    Ok(Evidence {
        base: task.base.clone(),
        head,
        files,
        test,
    })
}

pub(crate) fn run_test(cmd: &[String], cwd: &Path, cancel: &Cancel) -> TestResult {
    let mut command = Command::new(&cmd[0]);
    command.args(&cmd[1..]).current_dir(cwd);
    let (exit, output) = match capture(command, TEST_TIMEOUT, cancel) {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            if out.timed_out {
                text.push_str("\n[xdev: killed after the test timeout]");
            }
            if out.cancelled {
                text.push_str("\n[xdev: killed on stop]");
            }
            (out.status, text)
        }
        Err(e) => (None, format!("[xdev: could not start: {e}]")),
    };
    TestResult {
        command: cmd.to_vec(),
        exit,
        output_tail: tail(&output, OUTPUT_TAIL),
    }
}
