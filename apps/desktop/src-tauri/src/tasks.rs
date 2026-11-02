//! Coding-agent tasks for the Tasks view. A run waits on `claude` or `codex`
//! for up to an hour, so every call runs off the UI thread.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use xdev_agent::{
    AgentError, ClaudeRunner, CodexRunner, Routing, RunOptions, Runner, Task, TaskStore,
};
use xdev_ai::{AiError, Provider, Registry};
use xdev_core::Repo;
use xdev_policy::{Audited, Policy, PolicyError, Verdict};

use crate::accounts::{data_dir, local_dir};
use crate::commands::{AppState, CmdError};

/// Same as the CLI: long enough for a real change; a hung agent still ends.
const RUN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

impl From<AgentError> for CmdError {
    fn from(e: AgentError) -> CmdError {
        // The UI shows a gate's reason next to the policy file, so it must be
        // the policy's own words, not the error's prefixed message.
        let detail = match &e {
            AgentError::Gated(Verdict::Ask { reason } | Verdict::Deny { reason }) => reason.clone(),
            _ => e.to_string(),
        };
        CmdError {
            code: e.code(),
            detail: Some(detail),
        }
    }
}

impl From<PolicyError> for CmdError {
    fn from(e: PolicyError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TasksContext {
    /// The open vault's repo root, offered as the repo for a new task.
    default_repo: Option<String>,
    /// Where the person changes what the gate allows.
    policy_path: Option<String>,
}

/// A file at the evidence's base and head commits; `None` where it is absent.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FileDiff {
    old: Option<String>,
    new: Option<String>,
}

/// Claude Code with the person's own config when no account is named;
/// otherwise the runner of that account's provider.
fn runner(data: &Path, account: Option<&str>) -> Result<Box<dyn Runner>, CmdError> {
    let (provider, account_dir) = match account {
        Some(name) => {
            let registry = Registry::load(data)?;
            let entry = registry.get(name).ok_or(AiError::NotFound)?;
            (entry.provider, Some(entry.dir.clone()))
        }
        None => (Provider::Claude, None),
    };
    Ok(provider_runner(provider, account_dir))
}

pub(crate) fn provider_runner(provider: Provider, account_dir: Option<PathBuf>) -> Box<dyn Runner> {
    match provider {
        Provider::Claude => Box::new(ClaudeRunner {
            account_dir,
            timeout: RUN_TIMEOUT,
        }),
        Provider::Codex => Box::new(CodexRunner {
            account_dir,
            timeout: RUN_TIMEOUT,
        }),
    }
}

/// Loaded on every call, so an edit to the policy file applies to the next
/// step without restarting the app.
pub(crate) fn gate(data: &Path) -> Result<Audited<Policy>, CmdError> {
    Ok(Audited::new(Policy::load(data)?, data))
}

fn store(state: &AppState) -> Result<TaskStore, CmdError> {
    Ok(TaskStore::with_local(data_dir(state)?, local_dir(state)?))
}

#[tauri::command(async)]
pub fn tasks_context(state: State<'_, AppState>) -> TasksContext {
    TasksContext {
        // Without a vault or a repo there is simply no default to offer.
        default_repo: state
            .session
            .review()
            .ok()
            .map(|r| r.repo.root().display().to_string()),
        policy_path: state
            .data_dir
            .as_ref()
            .map(|d| d.join("policy.json").display().to_string()),
    }
}

#[tauri::command(async)]
pub fn tasks_list(state: State<'_, AppState>) -> Result<Vec<Task>, CmdError> {
    Ok(store(&state)?.list()?)
}

#[tauri::command(async)]
pub fn task_get(state: State<'_, AppState>, id: String) -> Result<Task, CmdError> {
    Ok(store(&state)?.load(&id)?)
}

#[tauri::command(async)]
pub fn task_new(state: State<'_, AppState>, repo: String, goal: String) -> Result<Task, CmdError> {
    Ok(store(&state)?.new_task(Path::new(&repo), &goal)?)
}

#[tauri::command(async)]
pub fn task_run(
    state: State<'_, AppState>,
    id: String,
    account: Option<String>,
    test: Option<String>,
) -> Result<Task, CmdError> {
    let data = data_dir(&state)?;
    let gate = gate(data)?;
    let runner = runner(data, account.as_deref())?;
    let store = store(&state)?;
    let opts = RunOptions {
        account,
        tools: Vec::new(),
        test: test_command(test.as_deref()),
        model: routed(data, &store, &id, &*runner)?,
    };
    Ok(store.run_task(&id, &*runner, &gate, &opts)?)
}

#[tauri::command(async)]
pub fn task_resume(
    state: State<'_, AppState>,
    id: String,
    account: Option<String>,
) -> Result<Task, CmdError> {
    let data = data_dir(&state)?;
    let gate = gate(data)?;
    let runner = runner(data, account.as_deref())?;
    let store = store(&state)?;
    let opts = RunOptions {
        account,
        model: routed(data, &store, &id, &*runner)?,
        ..RunOptions::default()
    };
    Ok(store.resume_task(&id, &*runner, &gate, &opts)?)
}

/// The person's routing rules judge a task on its goal, also when resumed.
fn routed(
    data: &Path,
    store: &TaskStore,
    id: &str,
    runner: &dyn Runner,
) -> Result<Option<String>, CmdError> {
    let goal = store.load(id)?.goal;
    Ok(Routing::load(data)?.pick("task", runner.provider(), &goal))
}

#[tauri::command(async)]
pub fn task_approve(state: State<'_, AppState>, id: String) -> Result<Task, CmdError> {
    let gate = gate(data_dir(&state)?)?;
    Ok(store(&state)?.approve_task(&id, &gate)?)
}

#[tauri::command(async)]
pub fn task_discard(state: State<'_, AppState>, id: String) -> Result<Task, CmdError> {
    Ok(store(&state)?.discard_task(&id)?)
}

#[tauri::command(async)]
pub fn task_file_diff(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<FileDiff, CmdError> {
    file_diff(&store(&state)?, &id, &path)
}

/// Split on whitespace like the CLI's `--test`; blank means no test.
fn test_command(test: Option<&str>) -> Option<Vec<String>> {
    let parts: Vec<String> = test?.split_whitespace().map(str::to_owned).collect();
    (!parts.is_empty()).then_some(parts)
}

fn file_diff(store: &TaskStore, id: &str, path: &str) -> Result<FileDiff, CmdError> {
    let task = store.load(id)?;
    let evidence = task
        .evidence
        .as_ref()
        .ok_or(AgentError::BadState(task.state.as_str()))?;
    // Only files the evidence lists, so this never reads arbitrary paths
    // out of the person's repo history.
    if !evidence.files.iter().any(|f| f.path == path) {
        return Err(AgentError::NotFound.into());
    }
    let repo = Repo::discover(&task.repo).map_err(AgentError::from)?;
    let read = |id: &str| -> Result<Option<String>, CmdError> {
        let bytes = repo.show(id, path).map_err(AgentError::from)?;
        bytes.map(text).transpose()
    };
    Ok(FileDiff {
        old: read(&evidence.base)?,
        new: read(&evidence.head)?,
    })
}

/// Git's own test for binary: a NUL byte. Invalid UTF-8 cannot be shown as
/// text either.
fn text(bytes: Vec<u8>) -> Result<String, CmdError> {
    let binary = || CmdError {
        code: "binary",
        detail: None,
    };
    if bytes.contains(&0) {
        return Err(binary());
    }
    String::from_utf8(bytes).map_err(|_| binary())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use xdev_agent::{Evidence, FileChange};

    use super::*;

    #[test]
    fn gated_errors_carry_the_policy_reason() {
        let ask = CmdError::from(AgentError::Gated(Verdict::Ask {
            reason: "merge requires approval".into(),
        }));
        assert_eq!(ask.code, "needs_approval");
        assert_eq!(ask.detail.as_deref(), Some("merge requires approval"));

        let deny = CmdError::from(AgentError::Gated(Verdict::Deny {
            reason: "merge denied by policy".into(),
        }));
        assert_eq!(deny.code, "denied");
        assert_eq!(deny.detail.as_deref(), Some("merge denied by policy"));
    }

    #[test]
    fn agent_and_policy_errors_keep_their_code() {
        assert_eq!(CmdError::from(AgentError::NotFound).code, "not_found");
        assert_eq!(
            CmdError::from(AgentError::BadState("merged")).code,
            "bad_state"
        );
        assert_eq!(CmdError::from(AgentError::DirtyRepo).code, "dirty_repo");
        assert_eq!(CmdError::from(AgentError::NoSession).code, "no_session");
        assert_eq!(
            CmdError::from(PolicyError::Parse("x".into())).code,
            "policy_invalid"
        );
    }

    #[test]
    fn a_broken_policy_file_stops_the_gate() {
        let data = tempfile::tempdir().unwrap();
        assert!(gate(data.path()).is_ok());
        fs::write(data.path().join("policy.json"), "{ not json").unwrap();
        assert_eq!(gate(data.path()).err().unwrap().code, "policy_invalid");
    }

    #[test]
    fn test_command_splits_like_the_cli() {
        assert_eq!(test_command(None), None);
        assert_eq!(test_command(Some("  ")), None);
        assert_eq!(
            test_command(Some(" cargo  test -q")),
            Some(vec!["cargo".into(), "test".into(), "-q".into()])
        );
    }

    #[test]
    fn contexts_serialize_like_the_ui_expects() {
        let ctx = TasksContext {
            default_repo: None,
            policy_path: Some("d/policy.json".into()),
        };
        assert_eq!(
            serde_json::to_value(ctx).unwrap(),
            serde_json::json!({ "defaultRepo": null, "policyPath": "d/policy.json" })
        );
    }

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

    /// A task whose evidence spans two commits: `kept.txt` changed,
    /// `gone.txt` removed, `new.txt` and the binary `bin.dat` added.
    fn reviewed() -> (tempfile::TempDir, tempfile::TempDir, TaskStore, String) {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        git(root, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(root, &["config", key, value]);
        }
        fs::write(root.join("kept.txt"), "one\n").unwrap();
        fs::write(root.join("gone.txt"), "bye\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "base"]);

        let data = tempfile::tempdir().unwrap();
        let store = TaskStore::new(data.path());
        let mut task = store.new_task(root, "Change files").unwrap();

        fs::write(root.join("kept.txt"), "one\ntwo\n").unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();
        fs::write(root.join("new.txt"), "hi\n").unwrap();
        fs::write(root.join("bin.dat"), [0u8, 1, 2, 0]).unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "head"]);
        let head = git(root, &["rev-parse", "HEAD"]).trim().to_owned();

        let change = |path: &str| FileChange {
            path: path.into(),
            added: None,
            removed: None,
        };
        task.evidence = Some(Evidence {
            base: task.base.clone(),
            head,
            files: ["bin.dat", "gone.txt", "kept.txt", "new.txt"]
                .map(change)
                .to_vec(),
            test: None,
        });
        store.save(&task).unwrap();
        let id = task.id.clone();
        (repo, data, store, id)
    }

    #[test]
    fn file_diff_reads_base_and_head() {
        let (_repo, _data, store, id) = reviewed();
        assert_eq!(
            file_diff(&store, &id, "kept.txt").unwrap(),
            FileDiff {
                old: Some("one\n".into()),
                new: Some("one\ntwo\n".into())
            }
        );
        assert_eq!(
            file_diff(&store, &id, "new.txt").unwrap(),
            FileDiff {
                old: None,
                new: Some("hi\n".into())
            }
        );
        assert_eq!(
            file_diff(&store, &id, "gone.txt").unwrap(),
            FileDiff {
                old: Some("bye\n".into()),
                new: None
            }
        );
        assert_eq!(
            file_diff(&store, &id, "bin.dat").unwrap_err().code,
            "binary"
        );
    }

    #[test]
    fn file_diff_only_reads_listed_files_of_a_task_with_evidence() {
        let (repo, _data, store, id) = reviewed();
        assert!(repo.path().join("new.txt").is_file());
        // A path outside the evidence is never read, even one git could find.
        assert_eq!(
            file_diff(&store, &id, "../kept.txt").unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            file_diff(&store, "nope", "kept.txt").unwrap_err().code,
            "not_found"
        );

        let fresh = store.new_task(repo.path(), "Another").unwrap();
        assert_eq!(
            file_diff(&store, &fresh.id, "kept.txt").unwrap_err().code,
            "bad_state"
        );
    }

    #[test]
    fn the_runner_follows_the_account_provider() {
        let data = tempfile::TempDir::new().unwrap();
        let mut registry = Registry::load(data.path()).unwrap();
        registry
            .add("cx", Provider::Codex, data.path().join("cx"))
            .unwrap();
        registry
            .add("cl", Provider::Claude, data.path().join("cl"))
            .unwrap();
        registry.save(data.path()).unwrap();

        let provider = |account| runner(data.path(), account).unwrap().provider().to_owned();
        assert_eq!(provider(Some("cx")), "codex");
        assert_eq!(provider(Some("cl")), "claude");
        assert_eq!(provider(None), "claude");
        assert_eq!(
            runner(data.path(), Some("nope")).err().unwrap().code,
            "not_found"
        );
    }
}
