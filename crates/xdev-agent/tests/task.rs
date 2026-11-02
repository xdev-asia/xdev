use std::cell::RefCell;
use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_agent::{
    AgentError, RunOptions, RunOutcome, RunRequest, Runner, Task, TaskState, TaskStore,
};
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

/// A repo with one commit and its own identity, so tests never read the
/// developer's global config; spaces in both paths on purpose.
struct Env {
    repo: TempDir,
    data: TempDir,
    store: TaskStore,
}

impl Env {
    fn new() -> Env {
        let repo = TempDir::with_prefix("task repo ").unwrap();
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
        let store = TaskStore::new(data.path());
        Env { repo, data, store }
    }

    fn head(&self) -> String {
        git(self.repo.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned()
    }

    fn branch(&self) -> String {
        git(self.repo.path(), &["branch", "--show-current"])
            .trim()
            .to_owned()
    }

    fn new_task(&self) -> Task {
        self.store
            .new_task(self.repo.path(), "Add agent.txt\nwith details")
            .unwrap()
    }

    /// A task already in `review` with `agent.txt` committed on its branch.
    fn reviewed(&self) -> Task {
        let task = self.new_task();
        self.store
            .run_task(&task.id, &FakeRunner::new(), &StubGate::allow(), &opts())
            .unwrap()
    }
}

fn opts() -> RunOptions {
    RunOptions::default()
}

/// Writes `agent.txt` like an agent would and answers with a session.
struct FakeRunner {
    seen: RefCell<Vec<RunRequest>>,
    fail: Option<fn() -> AgentError>,
}

impl FakeRunner {
    fn new() -> FakeRunner {
        FakeRunner {
            seen: RefCell::new(Vec::new()),
            fail: None,
        }
    }

    fn failing(fail: fn() -> AgentError) -> FakeRunner {
        FakeRunner {
            seen: RefCell::new(Vec::new()),
            fail: Some(fail),
        }
    }
}

impl Runner for FakeRunner {
    fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
        self.seen.borrow_mut().push(req.clone());
        if let Some(fail) = self.fail {
            return Err(fail());
        }
        fs::write(req.worktree.join("agent.txt"), "from the agent\n").unwrap();
        Ok(RunOutcome {
            session_id: Some("sess-1".into()),
            cost_usd: Some(0.25),
            is_error: false,
            result: "Wrote agent.txt".into(),
        })
    }
}

/// Answers every action of a kind the same way and keeps what it was asked.
struct StubGate {
    spawn: Verdict,
    command: Verdict,
    merge: Verdict,
    seen: RefCell<Vec<Action>>,
}

impl StubGate {
    fn allow() -> StubGate {
        StubGate {
            spawn: Verdict::Allow,
            command: Verdict::Allow,
            merge: Verdict::Ask {
                reason: "merge".into(),
            },
            seen: RefCell::new(Vec::new()),
        }
    }
}

impl Gate for StubGate {
    fn check(&self, action: &Action) -> Verdict {
        self.seen.borrow_mut().push(action.clone());
        match action {
            Action::SpawnAgent { .. } => self.spawn.clone(),
            Action::RunCommand { .. } => self.command.clone(),
            Action::Merge { .. } => self.merge.clone(),
            Action::Delete { .. } => Verdict::Deny {
                reason: "not used".into(),
            },
        }
    }
}

fn deny(reason: &str) -> Verdict {
    Verdict::Deny {
        reason: reason.into(),
    }
}

#[test]
fn new_task_makes_branch_and_worktree() {
    let env = Env::new();
    let task = env.new_task();
    assert_eq!(task.state, TaskState::Ready);
    assert_eq!(task.base, env.head());
    assert_eq!(task.branch, format!("xdev/task-{}", task.id));
    assert_eq!(
        task.worktree,
        env.data.path().join("worktrees").join(&task.id)
    );
    assert_eq!(
        git(&task.worktree, &["branch", "--show-current"]).trim(),
        task.branch
    );
    assert_eq!(
        fs::read_to_string(task.worktree.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(
        env.data
            .path()
            .join("tasks")
            .join(&task.id)
            .join("task.json")
            .is_file()
    );
    assert_eq!(env.store.load(&task.id).unwrap(), task);
}

#[test]
fn new_task_from_a_subfolder_uses_the_repo_root() {
    let env = Env::new();
    fs::create_dir(env.repo.path().join("sub")).unwrap();
    let task = env
        .store
        .new_task(&env.repo.path().join("sub"), "goal")
        .unwrap();
    assert_eq!(
        fs::canonicalize(&task.repo).unwrap(),
        fs::canonicalize(env.repo.path()).unwrap()
    );
}

#[test]
fn new_task_needs_a_repo_with_a_commit() {
    let env = Env::new();
    let plain = TempDir::new().unwrap();
    let err = env.store.new_task(plain.path(), "goal").unwrap_err();
    assert_eq!(err.code(), "no_repo");

    git(plain.path(), &["init", "-q"]);
    let err = env.store.new_task(plain.path(), "goal").unwrap_err();
    assert_eq!(err.code(), "no_commits");

    let err = env.store.new_task(env.repo.path(), "  ").unwrap_err();
    assert_eq!(err.code(), "empty_goal");
}

#[test]
fn run_commits_and_leaves_evidence_for_review() {
    let env = Env::new();
    let task = env.new_task();
    let runner = FakeRunner::new();
    let gate = StubGate::allow();
    let task = env
        .store
        .run_task(&task.id, &runner, &gate, &opts())
        .unwrap();

    assert_eq!(task.state, TaskState::Review);
    let evidence = task.evidence.as_ref().unwrap();
    assert_eq!(evidence.base, env.head());
    assert_ne!(evidence.head, evidence.base);
    assert_eq!(evidence.files.len(), 1);
    assert_eq!(evidence.files[0].path, "agent.txt");
    assert_eq!(evidence.files[0].added, Some(1));
    assert!(evidence.test.is_none());

    let run = &task.runs[0];
    assert_eq!(run.session_id.as_deref(), Some("sess-1"));
    assert_eq!(run.cost_usd, Some(0.25));
    assert_eq!(run.summary, "Wrote agent.txt");
    assert!(run.ended.is_some() && !run.is_error);

    assert_eq!(
        git(&task.worktree, &["log", "-1", "--format=%s"]).trim(),
        format!("task {}: Add agent.txt", task.id)
    );
    // The person's branch is untouched.
    assert_eq!(env.head(), task.base);

    let req = &runner.seen.borrow()[0];
    assert_eq!(req.resume, None);
    assert_eq!(req.tools, ["Read", "Edit", "Write", "Grep", "Glob"]);
    assert!(req.prompt.starts_with("Add agent.txt\nwith details"));
    assert_eq!(
        gate.seen.borrow()[0],
        Action::SpawnAgent {
            provider: "claude".into(),
            account: None,
            worktree: task.worktree.clone(),
            tools: req.tools.clone(),
        }
    );
    assert_eq!(env.store.load(&task.id).unwrap(), task);
}

#[test]
fn run_with_a_test_records_exit_and_output() {
    let env = Env::new();
    let task = env.new_task();
    let gate = StubGate::allow();
    let opts = RunOptions {
        test: Some(vec!["git".into(), "status".into(), "--short".into()]),
        ..RunOptions::default()
    };
    let task = env
        .store
        .run_task(&task.id, &FakeRunner::new(), &gate, &opts)
        .unwrap();
    let test = task.evidence.unwrap().test.unwrap();
    assert_eq!(test.command, ["git", "status", "--short"]);
    assert_eq!(test.exit, Some(0));
    // Run after the commit, so the tree is clean.
    assert_eq!(test.output_tail, "");
    assert!(matches!(
        &gate.seen.borrow()[1],
        Action::RunCommand { program, cwd, .. } if program == "git" && *cwd == task.worktree
    ));
}

#[test]
fn a_failing_test_still_leaves_review() {
    let env = Env::new();
    let task = env.new_task();
    let opts = RunOptions {
        test: Some(vec!["git".into(), "no-such-command".into()]),
        ..RunOptions::default()
    };
    let task = env
        .store
        .run_task(&task.id, &FakeRunner::new(), &StubGate::allow(), &opts)
        .unwrap();
    assert_eq!(task.state, TaskState::Review);
    let test = task.evidence.unwrap().test.unwrap();
    assert_ne!(test.exit, Some(0));
    assert!(test.output_tail.contains("no-such-command"), "{test:?}");
}

#[test]
fn deny_on_spawn_leaves_ready_and_runs_nothing() {
    let env = Env::new();
    let task = env.new_task();
    let runner = FakeRunner::new();
    let gate = StubGate {
        spawn: deny("no agents"),
        ..StubGate::allow()
    };
    let err = env
        .store
        .run_task(&task.id, &runner, &gate, &opts())
        .unwrap_err();
    assert_eq!(err.code(), "denied");
    assert!(matches!(err, AgentError::Gated(Verdict::Deny { .. })));
    assert!(runner.seen.borrow().is_empty());
    assert_eq!(env.store.load(&task.id).unwrap().state, TaskState::Ready);
}

#[test]
fn ask_on_the_test_command_stops_before_the_agent() {
    let env = Env::new();
    let task = env.new_task();
    let runner = FakeRunner::new();
    let gate = StubGate {
        command: Verdict::Ask {
            reason: "unknown program".into(),
        },
        ..StubGate::allow()
    };
    let opts = RunOptions {
        test: Some(vec!["make".into(), "test".into()]),
        ..RunOptions::default()
    };
    let err = env
        .store
        .run_task(&task.id, &runner, &gate, &opts)
        .unwrap_err();
    assert_eq!(err.code(), "needs_approval");
    assert!(runner.seen.borrow().is_empty());
    assert_eq!(env.store.load(&task.id).unwrap().state, TaskState::Ready);
}

#[test]
fn runner_error_fails_the_task() {
    let env = Env::new();
    let task = env.new_task();
    let runner = FakeRunner::failing(|| AgentError::Runner("boom".into()));
    let err = env
        .store
        .run_task(&task.id, &runner, &StubGate::allow(), &opts())
        .unwrap_err();
    assert_eq!(err.code(), "runner");
    let task = env.store.load(&task.id).unwrap();
    assert_eq!(task.state, TaskState::Failed);
    assert!(task.runs[0].is_error);
    assert!(task.runs[0].summary.contains("boom"));
    assert!(task.evidence.is_none());

    // A failed task can be run again.
    let task = env
        .store
        .run_task(&task.id, &FakeRunner::new(), &StubGate::allow(), &opts())
        .unwrap();
    assert_eq!(task.state, TaskState::Review);
    assert_eq!(task.runs.len(), 2);
}

#[test]
fn timeout_with_a_session_pauses_and_resume_passes_it() {
    let env = Env::new();
    let task = env.new_task();
    let runner = FakeRunner::failing(|| AgentError::Timeout {
        session_id: Some("sess-9".into()),
    });
    env.store
        .run_task(&task.id, &runner, &StubGate::allow(), &opts())
        .unwrap_err();
    let paused = env.store.load(&task.id).unwrap();
    assert_eq!(paused.state, TaskState::Paused);
    assert_eq!(paused.last_session(), Some("sess-9"));

    let runner = FakeRunner::new();
    let task = env
        .store
        .resume_task(&task.id, &runner, &StubGate::allow(), &opts())
        .unwrap();
    assert_eq!(task.state, TaskState::Review);
    let req = &runner.seen.borrow()[0];
    assert_eq!(req.resume.as_deref(), Some("sess-9"));
}

#[test]
fn timeout_without_a_session_fails_and_cannot_resume() {
    let env = Env::new();
    let task = env.new_task();
    let runner = FakeRunner::failing(|| AgentError::Timeout { session_id: None });
    env.store
        .run_task(&task.id, &runner, &StubGate::allow(), &opts())
        .unwrap_err();
    assert_eq!(env.store.load(&task.id).unwrap().state, TaskState::Failed);
    let err = env
        .store
        .resume_task(&task.id, &FakeRunner::new(), &StubGate::allow(), &opts())
        .unwrap_err();
    assert_eq!(err.code(), "no_session");
}

#[test]
fn running_without_a_live_run_loads_as_paused() {
    let env = Env::new();
    let mut task = env.new_task();
    task.state = TaskState::Running;
    env.store.save(&task).unwrap();
    assert_eq!(env.store.load(&task.id).unwrap().state, TaskState::Paused);
    assert_eq!(env.store.list().unwrap()[0].state, TaskState::Paused);
}

#[test]
fn list_is_newest_first_and_skips_junk() {
    let env = Env::new();
    let mut a = env.new_task();
    let mut b = env.new_task();
    // Ids from the same second still need a fixed order for the check.
    a.id = "20260101-000000-aaaa".into();
    b.id = "20261231-000000-bbbb".into();
    env.store.create(&a).unwrap();
    env.store.create(&b).unwrap();
    fs::create_dir_all(env.data.path().join("tasks").join("junk")).unwrap();
    let ids: Vec<String> = env
        .store
        .list()
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(ids[0], b.id);
    assert!(ids.windows(2).all(|w| w[0] > w[1]));
    assert_eq!(env.store.load("../x").unwrap_err().code(), "not_found");
    assert_eq!(
        env.store.load("20200101-000000-0000").unwrap_err().code(),
        "not_found"
    );
}

#[test]
fn approve_merges_into_the_repo_branch() {
    let env = Env::new();
    let task = env.reviewed();
    let into = env.branch();
    let gate = StubGate::allow();
    let task = env.store.approve_task(&task.id, &gate).unwrap();

    assert_eq!(task.state, TaskState::Merged);
    let merge = task.approval.as_ref().unwrap().merge_commit.clone();
    assert_eq!(env.head(), merge);
    assert_eq!(env.branch(), into);
    let parents = git(
        env.repo.path(),
        &["rev-list", "--parents", "-n", "1", &merge],
    );
    assert_eq!(parents.split_whitespace().count(), 3);
    assert_eq!(
        git(env.repo.path(), &["log", "-1", "--format=%s"]).trim(),
        format!("Merge task {}: Add agent.txt", task.id)
    );
    assert_eq!(
        fs::read_to_string(env.repo.path().join("agent.txt")).unwrap(),
        "from the agent\n"
    );
    assert!(!task.worktree.exists());
    assert_eq!(
        git(env.repo.path(), &["branch", "--list", &task.branch]).trim(),
        task.branch
    );
    assert_eq!(
        gate.seen.borrow()[0],
        Action::Merge {
            from: task.branch.clone(),
            into,
        }
    );
    assert_eq!(env.store.load(&task.id).unwrap(), task);
}

#[test]
fn approve_refuses_deny_dirty_repo_and_wrong_state() {
    let env = Env::new();
    let ready = env.new_task();
    let err = env
        .store
        .approve_task(&ready.id, &StubGate::allow())
        .unwrap_err();
    assert_eq!(err.code(), "bad_state");

    let task = env.reviewed();
    let gate = StubGate {
        merge: deny("never"),
        ..StubGate::allow()
    };
    let err = env.store.approve_task(&task.id, &gate).unwrap_err();
    assert_eq!(err.code(), "denied");

    let before = env.head();
    fs::write(env.repo.path().join("README.md"), "edited\n").unwrap();
    let err = env
        .store
        .approve_task(&task.id, &StubGate::allow())
        .unwrap_err();
    assert_eq!(err.code(), "dirty_repo");
    assert_eq!(env.head(), before);
    assert_eq!(env.store.load(&task.id).unwrap().state, TaskState::Review);
}

#[test]
fn merge_conflict_aborts_and_stays_in_review() {
    let env = Env::new();
    let task = env.reviewed();
    fs::write(env.repo.path().join("agent.txt"), "the person's own\n").unwrap();
    git(env.repo.path(), &["add", "-A"]);
    git(env.repo.path(), &["commit", "-q", "-m", "mine"]);
    let before = env.head();

    let err = env
        .store
        .approve_task(&task.id, &StubGate::allow())
        .unwrap_err();
    assert_eq!(err.code(), "merge_conflict");
    assert_eq!(env.head(), before);
    assert_eq!(git(env.repo.path(), &["status", "--porcelain"]), "");
    let task = env.store.load(&task.id).unwrap();
    assert_eq!(task.state, TaskState::Review);
    assert!(task.approval.is_none());
    assert!(task.worktree.is_dir());
}

#[test]
fn discard_removes_worktree_and_branch() {
    let env = Env::new();
    let task = env.reviewed();
    let task = env.store.discard_task(&task.id).unwrap();
    assert_eq!(task.state, TaskState::Discarded);
    assert!(!task.worktree.exists());
    assert_eq!(
        git(env.repo.path(), &["branch", "--list", &task.branch]),
        ""
    );
    assert_eq!(
        env.store.load(&task.id).unwrap().state,
        TaskState::Discarded
    );
    let err = env.store.discard_task(&task.id).unwrap_err();
    assert_eq!(err.code(), "bad_state");
}

#[test]
fn run_refuses_a_task_in_review() {
    let env = Env::new();
    let task = env.reviewed();
    let err = env
        .store
        .run_task(&task.id, &FakeRunner::new(), &StubGate::allow(), &opts())
        .unwrap_err();
    assert_eq!(err.code(), "bad_state");
}
