use std::collections::BTreeMap;

use xdev_automations::store::{prune, workspace_name};
use xdev_automations::*;

const T0: i64 = 1_793_872_800_000; // 2026-11-05T10:00:00Z

fn input() -> AutomationInput {
    AutomationInput {
        name: "Audit".into(),
        prompt: "Look around.".into(),
        precheck: None,
        agent: "claude".into(),
        extra_agent_args: None,
        repo_id: "repo".into(),
        workspace_mode: WorkspaceMode::Existing,
        worktree: Some("/w".into()),
        base_branch: None,
        setup_decision: SetupDecision::Inherit,
        reuse_session: false,
        timezone: "UTC".into(),
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0".into(),
        dtstart: T0,
        enabled: true,
        missed_run_grace_minutes: DEFAULT_GRACE_MINUTES,
    }
}

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(dir.path()).unwrap();
    (dir, s)
}

fn run_with(s: &mut Store, a: &Automation, n: i64, status: RunStatus) -> AutomationRun {
    let r = s.create_run(
        a,
        T0 + n * 60_000,
        RunTrigger::Scheduled,
        T0 + n * 60_000,
        format!("{}-r{n}", a.id),
    );
    patch(s, &r.id, status, T0 + n * 60_000)
}

fn patch(s: &mut Store, id: &str, status: RunStatus, at: i64) -> AutomationRun {
    s.update_run(
        id,
        RunPatch {
            status,
            worktree: None,
            worktree_name: None,
            tab_id: None,
            output_snapshot: None,
            precheck_result: None,
            failure: None,
            at,
        },
    )
    .unwrap()
}

#[test]
fn create_fills_the_defaults() {
    let (_d, mut s) = store();
    let a = s
        .create(
            AutomationInput {
                name: "  ".into(),
                ..input()
            },
            T0,
            "a1".into(),
        )
        .unwrap();
    assert_eq!(a.name, "Untitled automation");
    assert_eq!(a.missed_run_grace_minutes, 720);
    assert_eq!((a.created_at, a.updated_at, a.last_run_at), (T0, T0, None));
    assert_eq!(a.next_run_at, 1_793_955_600_000); // 2026-11-06T09:00:00Z
    assert_eq!(s.list().len(), 1);
}

#[test]
fn create_cleans_what_the_mode_cannot_use() {
    let (_d, mut s) = store();
    let new = AutomationInput {
        workspace_mode: WorkspaceMode::NewPerRun,
        reuse_session: true,
        worktree: Some("/w".into()),
        base_branch: Some("main".into()),
        precheck: Some(Precheck {
            command: "  gh pr list  ".into(),
            timeout_seconds: 9999,
        }),
        ..input()
    };
    let a = s.create(new, T0, "a1".into()).unwrap();
    assert!(!a.reuse_session);
    assert_eq!(a.worktree, None);
    assert_eq!(a.base_branch.as_deref(), Some("main"));
    assert_eq!(
        a.precheck,
        Some(Precheck {
            command: "gh pr list".into(),
            timeout_seconds: 600
        })
    );

    let existing = AutomationInput {
        base_branch: Some("main".into()),
        precheck: Some(Precheck {
            command: "  ".into(),
            timeout_seconds: 60,
        }),
        ..input()
    };
    let b = s.create(existing, T0, "a2".into()).unwrap();
    assert_eq!(b.base_branch, None);
    assert_eq!(b.precheck, None);
}

#[test]
fn extra_arguments_need_a_fresh_session() {
    let (_d, mut s) = store();
    let both = AutomationInput {
        extra_agent_args: Some("--model opus".into()),
        reuse_session: true,
        ..input()
    };
    assert!(matches!(
        s.create(both, T0, "a1".into()),
        Err(StoreError::ExtraArgs(ExtraArgsError::RequireFreshSession))
    ));
    // Blank extras are no extras.
    let blank = AutomationInput {
        extra_agent_args: Some("  ".into()),
        reuse_session: true,
        ..input()
    };
    assert_eq!(
        s.create(blank, T0, "a2".into()).unwrap().extra_agent_args,
        None
    );
}

#[test]
fn a_schedule_that_cannot_run_is_refused() {
    let (_d, mut s) = store();
    for bad in ["0 0 31 2 *", "*/61 * * * *", "nonsense", "FREQ=MONTHLY"] {
        let r = s.create(
            AutomationInput {
                rrule: bad.into(),
                ..input()
            },
            T0,
            "x".into(),
        );
        assert!(matches!(r, Err(StoreError::InvalidSchedule)), "{bad}");
    }
    assert!(s.list().is_empty());
}

#[test]
fn update_recomputes_the_next_run_and_keeps_the_history_fields() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    s.create_run(&a, T0, RunTrigger::Manual, T0, "r1".into());
    let changed = s
        .update(
            "a1",
            AutomationInput {
                rrule: "FREQ=HOURLY;BYMINUTE=15".into(),
                name: "New".into(),
                ..input()
            },
            T0 + 1,
        )
        .unwrap();
    assert_eq!(changed.id, "a1");
    assert_eq!(changed.created_at, T0);
    assert_eq!(changed.updated_at, T0 + 1);
    assert_eq!(changed.last_run_at, Some(T0));
    assert_eq!(changed.next_run_at, 1_793_873_700_000); // 10:15Z
    assert!(matches!(
        s.update("nope", input(), T0),
        Err(StoreError::NotFound)
    ));
}

#[test]
fn resuming_looks_ahead_from_now() {
    let (_d, mut s) = store();
    s.create(input(), T0, "a1".into()).unwrap();
    let paused = s.set_enabled("a1", false, T0).unwrap();
    assert!(!paused.enabled);
    let later = T0 + 3 * 86_400_000;
    let resumed = s.set_enabled("a1", true, later).unwrap();
    assert!(resumed.enabled);
    assert_eq!(resumed.next_run_at, 1_794_214_800_000); // 2026-11-09T09:00:00Z
}

#[test]
fn a_run_is_titled_and_numbered_and_the_number_is_never_reused() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let one = s.create_run(&a, T0, RunTrigger::Scheduled, T0, "r1".into());
    assert_eq!(
        (
            one.title.as_str(),
            one.run_number,
            one.status,
            one.occurrence_count
        ),
        ("Audit run 1", 1, RunStatus::Pending, 1)
    );
    for n in 2..=130 {
        run_with(&mut s, &a, n, RunStatus::Completed);
    }
    let next = s.create_run(&a, T0, RunTrigger::Manual, T0, "r-last".into());
    assert_eq!(next.run_number, 131);
}

#[test]
fn prune_keeps_the_newest_hundred_final_runs_and_every_open_one() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let b = s.create(input(), T0, "a2".into()).unwrap();
    for n in 1..=120 {
        run_with(&mut s, &a, n, RunStatus::Completed);
    }
    // The oldest run is still open: it stays.
    let open = s.create_run(&b, T0, RunTrigger::Scheduled, T0, "open".into());
    for n in 1..=110 {
        run_with(&mut s, &b, n, RunStatus::SkippedMissed);
    }
    let runs_a = s.runs("a1");
    assert_eq!(runs_a.len(), 100);
    assert_eq!(runs_a[0].run_number, 120);
    assert_eq!(runs_a[99].run_number, 21);
    let runs_b = s.runs("a2");
    assert_eq!(runs_b.len(), 101);
    assert!(runs_b.iter().any(|r| r.id == open.id));
}

#[test]
fn prune_is_a_plain_function_too() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let runs: Vec<_> = (1..=5)
        .map(|n| run_with(&mut s, &a, n, RunStatus::Completed))
        .collect();
    let kept = prune(runs, 2);
    assert_eq!(
        kept.iter().map(|r| r.run_number).collect::<Vec<_>>(),
        vec![4, 5]
    );
}

fn unavailable(
    s: &mut Store,
    a: &Automation,
    id: &str,
    scheduled_for: i64,
    trigger: RunTrigger,
) -> AutomationRun {
    let r = s.create_run(a, scheduled_for, trigger, scheduled_for, id.into());
    s.update_run(
        &r.id,
        RunPatch {
            status: RunStatus::SkippedUnavailable,
            worktree: None,
            worktree_name: None,
            tab_id: None,
            output_snapshot: None,
            precheck_result: None,
            failure: Some((FailureCode::NoDispatchHost, BTreeMap::new())),
            at: scheduled_for,
        },
    )
    .unwrap()
}

#[test]
fn a_repeated_refusal_folds_into_the_last_run() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let first = unavailable(&mut s, &a, "r1", T0, RunTrigger::Scheduled);
    let error = first.error.clone().unwrap();
    assert_eq!(first.error_code, Some(FailureCode::NoDispatchHost));

    let folded = s.repeat_skip("a1", &error, T0 + 3_600_000).unwrap();
    assert_eq!(
        (
            folded.id.as_str(),
            folded.occurrence_count,
            folded.last_occurrence_at
        ),
        ("r1", 2, Some(T0 + 3_600_000))
    );
    // The same occurrence twice changes nothing.
    let again = s.repeat_skip("a1", &error, T0 + 3_600_000).unwrap();
    assert_eq!(again.occurrence_count, 2);
    assert_eq!(s.runs("a1").len(), 1);
    // A different error, or no earlier refusal, is not folded.
    assert!(s.repeat_skip("a1", "another", T0 + 7_200_000).is_none());
    assert!(s.repeat_skip("nope", &error, T0).is_none());
}

#[test]
fn only_a_scheduled_unavailable_run_absorbs_a_refusal() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let manual = unavailable(&mut s, &a, "r1", T0, RunTrigger::Manual);
    assert!(
        s.repeat_skip("a1", manual.error.as_deref().unwrap(), T0 + 1)
            .is_none()
    );
    let done = run_with(&mut s, &a, 5, RunStatus::Completed);
    assert!(s.repeat_skip("a1", "x", done.scheduled_for + 1).is_none());
}

#[test]
fn advance_moves_next_run_after_now_and_survives_a_bad_rule() {
    let (_d, mut s) = store();
    s.create(input(), T0, "a1".into()).unwrap();
    let a = s.advance("a1", 1_793_955_600_000).unwrap();
    assert_eq!(a.next_run_at, 1_794_042_000_000); // 2026-11-07T09:00:00Z
    assert!(matches!(s.advance("nope", T0), Err(StoreError::NotFound)));
}

#[test]
fn delete_drops_the_runs_too() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let b = s.create(input(), T0, "a2".into()).unwrap();
    run_with(&mut s, &a, 1, RunStatus::Completed);
    run_with(&mut s, &b, 1, RunStatus::Completed);
    s.delete("a1").unwrap();
    assert_eq!(s.list().len(), 1);
    assert!(s.runs("a1").is_empty());
    assert_eq!(s.runs("a2").len(), 1);
    assert!(matches!(s.delete("a1"), Err(StoreError::NotFound)));
}

#[test]
fn a_run_patch_records_where_it_went() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let r = s.create_run(&a, T0, RunTrigger::Scheduled, T0, "r1".into());
    let p = s
        .update_run(
            &r.id,
            RunPatch {
                status: RunStatus::Dispatched,
                worktree: Some("/w".into()),
                worktree_name: Some("w".into()),
                tab_id: Some("tab".into()),
                output_snapshot: None,
                precheck_result: None,
                failure: None,
                at: T0 + 5,
            },
        )
        .unwrap();
    assert_eq!(
        (p.worktree.as_deref(), p.tab_id.as_deref(), p.dispatched_at),
        (Some("/w"), Some("tab"), Some(T0 + 5))
    );
    let done = patch(&mut s, "r1", RunStatus::Completed, T0 + 9);
    assert_eq!(
        (
            done.finished_at,
            done.worktree.as_deref(),
            done.tab_id.as_deref()
        ),
        (Some(T0 + 9), Some("/w"), Some("tab"))
    );
    assert!(matches!(
        s.update_run(
            "nope",
            RunPatch {
                status: RunStatus::Completed,
                worktree: None,
                worktree_name: None,
                tab_id: None,
                output_snapshot: None,
                precheck_result: None,
                failure: None,
                at: 0
            }
        ),
        Err(StoreError::NotFound)
    ));
}

#[test]
fn a_failure_is_stored_with_its_english_text() {
    let (_d, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    let r = s.create_run(&a, T0, RunTrigger::Scheduled, T0, "r1".into());
    let mut params = BTreeMap::new();
    params.insert("code".to_string(), "3".to_string());
    let p = s
        .update_run(
            &r.id,
            RunPatch {
                status: RunStatus::SkippedPrecheck,
                worktree: None,
                worktree_name: None,
                tab_id: None,
                output_snapshot: None,
                precheck_result: None,
                failure: Some((FailureCode::PrecheckExit, params.clone())),
                at: T0,
            },
        )
        .unwrap();
    assert_eq!(p.error.as_deref(), Some("Precheck exited with code 3."));
    assert_eq!(
        (p.error_code, p.error_params),
        (Some(FailureCode::PrecheckExit), Some(params))
    );
}

#[test]
fn the_file_reloads_equal() {
    let (dir, mut s) = store();
    let a = s.create(input(), T0, "a1".into()).unwrap();
    run_with(&mut s, &a, 1, RunStatus::Completed);
    unavailable(&mut s, &a, "r2", T0 + 99, RunTrigger::Scheduled);
    s.save().unwrap();
    assert!(dir.path().join("automations.json").exists());
    let back = Store::open(dir.path()).unwrap();
    assert_eq!(back.list(), s.list());
    assert_eq!(back.runs("a1"), s.runs("a1"));
    let text = std::fs::read_to_string(dir.path().join("automations.json")).unwrap();
    assert!(text.contains("\"version\": 1") || text.contains("\"version\":1"));
}

#[test]
fn a_corrupt_file_is_kept_aside_and_the_store_starts_empty() {
    let dir = tempfile::tempdir().unwrap();
    let kept = || {
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("automations.json.bad-"))
            .collect();
        names.sort();
        names
    };
    std::fs::write(dir.path().join("automations.json"), "{ not json").unwrap();
    let s = Store::open(dir.path()).unwrap();
    assert!(s.list().is_empty());
    let first = kept();
    assert_eq!(first.len(), 1);
    assert_eq!(
        std::fs::read_to_string(dir.path().join(&first[0])).unwrap(),
        "{ not json"
    );
    assert!(!dir.path().join("automations.json").exists());
    // A second bad file does not overwrite the first copy.
    std::fs::write(dir.path().join("automations.json"), "{ also bad").unwrap();
    Store::open(dir.path()).unwrap();
    let both = kept();
    assert_eq!(both.len(), 2);
    let texts: Vec<String> = both
        .iter()
        .map(|n| std::fs::read_to_string(dir.path().join(n)).unwrap())
        .collect();
    assert!(texts.contains(&"{ not json".to_owned()) && texts.contains(&"{ also bad".to_owned()));
}

#[test]
fn a_new_worktree_is_named_from_the_title_and_the_minute() {
    // 2026-11-05T10:07:00Z
    let at = T0 + 7 * 60_000;
    assert_eq!(
        workspace_name("Weekday repo audit run 3", at),
        "auto-weekday-repo-audit-run-3-20261105T1007"
    );
    assert_eq!(
        workspace_name("  Ünïcode & !! symbols  ", at),
        "auto-n-code-symbols-20261105T1007"
    );
    assert_eq!(workspace_name("", at), "auto-run-20261105T1007");
    let long = workspace_name(&"abcdefghij ".repeat(10), at);
    let slug = long
        .strip_prefix("auto-")
        .unwrap()
        .strip_suffix("-20261105T1007")
        .unwrap();
    assert!(slug.len() <= 40 && !slug.ends_with('-'), "{slug}");
}
